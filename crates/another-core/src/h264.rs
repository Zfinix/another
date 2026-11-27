//! Rewrites an H.264 SPS so decoders know frames are never reordered.
//!
//! Hardware encoders often omit the VUI `bitstream_restriction`, so a decoder has to assume the level's
//! worst-case reorder depth and holds decoded frames back before showing them. Declaring
//! `max_num_reorder_frames = 0` lets it output each frame as soon as it is decoded. The stream must
//! not contain B-frames, which the encoder is told to avoid with `max-bframes=0`.

const NAL_TYPE_SPS: u8 = 7;
const MAX_LOG2_MV_LENGTH: u32 = 16;
/// aspect ratio, overscan, video signal, chroma location, timing, NAL HRD, VCL HRD, pic struct
const EMPTY_VUI_FLAGS: usize = 8;
const PROFILES_WITH_CHROMA_INFO: [u8; 12] = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134];

pub fn is_sps(nal: &[u8]) -> bool {
    nal.first().is_some_and(|header| header & 0x1F == NAL_TYPE_SPS)
}

/// Returns the SPS NAL with a bitstream restriction declaring no reordering, or `None` when the SPS
/// already declares one or cannot be parsed. The input and output include the NAL header byte.
pub fn declare_no_reordering(sps_nal: &[u8]) -> Option<Vec<u8>> {
    if !is_sps(sps_nal) || sps_nal.len() < 4 {
        return None;
    }
    let rbsp = unescape(&sps_nal[1..]);
    let mut reader = BitReader::new(&rbsp);
    let parsed = parse_up_to_restriction(&mut reader)?;
    if parsed.has_restriction {
        return None;
    }

    let mut writer = BitWriter::default();
    let mut copy = BitReader::new(&rbsp);
    let copy_bits = if parsed.vui_present {
        parsed.restriction_flag_pos
    } else {
        parsed.vui_flag_pos
    };
    for _ in 0..copy_bits {
        writer.write_bit(copy.read_bit()?);
    }
    if !parsed.vui_present {
        writer.write_bit(true);
        for _ in 0..EMPTY_VUI_FLAGS {
            writer.write_bit(false);
        }
    }
    writer.write_bit(true);
    writer.write_bit(true);
    writer.write_ue(2);
    writer.write_ue(1);
    writer.write_ue(MAX_LOG2_MV_LENGTH);
    writer.write_ue(MAX_LOG2_MV_LENGTH);
    writer.write_ue(0);
    writer.write_ue(parsed.max_num_ref_frames.max(1));
    writer.write_trailing_bits();

    let mut out = Vec::with_capacity(sps_nal.len() + 4);
    out.push(sps_nal[0]);
    out.extend_from_slice(&escape(&writer.into_bytes()));
    Some(out)
}

struct ParsedSps {
    vui_present: bool,
    has_restriction: bool,
    max_num_ref_frames: u32,
    vui_flag_pos: usize,
    restriction_flag_pos: usize,
}

fn parse_up_to_restriction(r: &mut BitReader) -> Option<ParsedSps> {
    let profile_idc = r.read_bits(8)? as u8;
    r.skip(16)?;
    r.read_ue()?;
    if PROFILES_WITH_CHROMA_INFO.contains(&profile_idc) || profile_idc == 135 {
        let chroma_format_idc = r.read_ue()?;
        if chroma_format_idc == 3 {
            r.skip(1)?;
        }
        r.read_ue()?;
        r.read_ue()?;
        r.skip(1)?;
        if r.read_bit()? {
            let lists = if chroma_format_idc == 3 { 12 } else { 8 };
            for i in 0..lists {
                if r.read_bit()? {
                    skip_scaling_list(r, if i < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    r.read_ue()?;
    match r.read_ue()? {
        0 => {
            r.read_ue()?;
        }
        1 => {
            r.skip(1)?;
            r.read_se()?;
            r.read_se()?;
            for _ in 0..r.read_ue()? {
                r.read_se()?;
            }
        }
        _ => {}
    }
    let max_num_ref_frames = r.read_ue()?;
    r.skip(1)?;
    r.read_ue()?;
    r.read_ue()?;
    if !r.read_bit()? {
        r.skip(1)?;
    }
    r.skip(1)?;
    if r.read_bit()? {
        for _ in 0..4 {
            r.read_ue()?;
        }
    }

    let vui_flag_pos = r.pos;
    if !r.read_bit()? {
        return Some(ParsedSps {
            vui_present: false,
            has_restriction: false,
            max_num_ref_frames,
            vui_flag_pos,
            restriction_flag_pos: 0,
        });
    }

    if r.read_bit()? && r.read_bits(8)? == 255 {
        r.skip(32)?;
    }
    if r.read_bit()? {
        r.skip(1)?;
    }
    if r.read_bit()? {
        r.skip(4)?;
        if r.read_bit()? {
            r.skip(24)?;
        }
    }
    if r.read_bit()? {
        r.read_ue()?;
        r.read_ue()?;
    }
    if r.read_bit()? {
        r.skip(65)?;
    }
    let nal_hrd = r.read_bit()?;
    if nal_hrd {
        skip_hrd_parameters(r)?;
    }
    let vcl_hrd = r.read_bit()?;
    if vcl_hrd {
        skip_hrd_parameters(r)?;
    }
    if nal_hrd || vcl_hrd {
        r.skip(1)?;
    }
    r.skip(1)?;

    let restriction_flag_pos = r.pos;
    let has_restriction = r.read_bit()?;
    Some(ParsedSps {
        vui_present: true,
        has_restriction,
        max_num_ref_frames,
        vui_flag_pos,
        restriction_flag_pos,
    })
}

fn skip_scaling_list(r: &mut BitReader, size: usize) -> Option<()> {
    let mut last_scale = 8i64;
    let mut next_scale = 8i64;
    for _ in 0..size {
        if next_scale != 0 {
            let delta = r.read_se()?;
            next_scale = (last_scale + delta + 256) % 256;
        }
        if next_scale != 0 {
            last_scale = next_scale;
        }
    }
    Some(())
}

fn skip_hrd_parameters(r: &mut BitReader) -> Option<()> {
    let cpb_cnt = r.read_ue()? + 1;
    r.skip(8)?;
    for _ in 0..cpb_cnt {
        r.read_ue()?;
        r.read_ue()?;
        r.skip(1)?;
    }
    r.skip(20)
}

fn unescape(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut zeros = 0;
    for &byte in data {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        out.push(byte);
    }
    out
}

fn escape(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 4);
    let mut zeros = 0;
    for &byte in data {
        if zeros >= 2 && byte <= 3 {
            out.push(3);
            zeros = 0;
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        out.push(byte);
    }
    out
}

struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn read_bit(&mut self) -> Option<bool> {
        let byte = *self.data.get(self.pos / 8)?;
        let bit = (byte >> (7 - self.pos % 8)) & 1 == 1;
        self.pos += 1;
        Some(bit)
    }

    fn read_bits(&mut self, n: u32) -> Option<u32> {
        let mut value = 0u32;
        for _ in 0..n {
            value = (value << 1) | u32::from(self.read_bit()?);
        }
        Some(value)
    }

    fn skip(&mut self, n: usize) -> Option<()> {
        if self.pos + n > self.data.len() * 8 {
            return None;
        }
        self.pos += n;
        Some(())
    }

    fn read_ue(&mut self) -> Option<u32> {
        let mut leading_zeros = 0;
        while !self.read_bit()? {
            leading_zeros += 1;
            if leading_zeros > 31 {
                return None;
            }
        }
        Some((1u32 << leading_zeros) - 1 + self.read_bits(leading_zeros)?)
    }

    fn read_se(&mut self) -> Option<i64> {
        let code = i64::from(self.read_ue()?);
        Some(if code % 2 == 1 { (code + 1) / 2 } else { -(code / 2) })
    }
}

#[derive(Default)]
struct BitWriter {
    bytes: Vec<u8>,
    current: u8,
    filled: u8,
}

impl BitWriter {
    fn write_bit(&mut self, bit: bool) {
        self.current = (self.current << 1) | u8::from(bit);
        self.filled += 1;
        if self.filled == 8 {
            self.bytes.push(self.current);
            self.current = 0;
            self.filled = 0;
        }
    }

    fn write_bits(&mut self, value: u32, n: u32) {
        for i in (0..n).rev() {
            self.write_bit((value >> i) & 1 == 1);
        }
    }

    fn write_ue(&mut self, value: u32) {
        let code = value + 1;
        let len = 32 - code.leading_zeros();
        self.write_bits(0, len - 1);
        self.write_bits(code, len);
    }

    fn write_trailing_bits(&mut self) {
        self.write_bit(true);
        while self.filled != 0 {
            self.write_bit(false);
        }
    }

    fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real SPS from the Android emulator's encoder, which already declares no reordering.
    const EMULATOR_SPS: [u8; 18] = [
        0x67, 0x42, 0xc0, 0x29, 0x8d, 0x68, 0x04, 0x00, 0xee, 0x90, 0x80, 0x80, 0x80, 0x83, 0xc2, 0x21, 0x1a,
        0x80,
    ];

    fn parse(nal: &[u8]) -> ParsedSps {
        let rbsp = unescape(&nal[1..]);
        parse_up_to_restriction(&mut BitReader::new(&rbsp)).expect("parses")
    }

    /// The emulator SPS truncated after `keep` bits, followed by `tail` bits and trailing bits.
    fn variant(keep: usize, tail: &[bool]) -> Vec<u8> {
        let rbsp = unescape(&EMULATOR_SPS[1..]);
        let mut r = BitReader::new(&rbsp);
        let mut w = BitWriter::default();
        for _ in 0..keep {
            w.write_bit(r.read_bit().expect("bit"));
        }
        for &bit in tail {
            w.write_bit(bit);
        }
        w.write_trailing_bits();
        let mut nal = vec![EMULATOR_SPS[0]];
        nal.extend_from_slice(&escape(&w.into_bytes()));
        nal
    }

    fn sps_without_vui() -> Vec<u8> {
        let parsed = parse(&EMULATOR_SPS);
        variant(parsed.vui_flag_pos, &[false])
    }

    fn vui_without_restriction() -> Vec<u8> {
        let parsed = parse(&EMULATOR_SPS);
        variant(parsed.restriction_flag_pos, &[false])
    }

    #[test]
    fn the_emulator_sps_already_declares_a_restriction() {
        let parsed = parse(&EMULATOR_SPS);
        assert!(parsed.vui_present);
        assert!(parsed.has_restriction);
        assert_eq!(parsed.max_num_ref_frames, 1);
        assert_eq!(declare_no_reordering(&EMULATOR_SPS), None);
    }

    #[test]
    fn adds_a_restriction_to_a_vui_without_one() {
        let input = vui_without_restriction();
        assert!(!parse(&input).has_restriction);

        let rewritten = declare_no_reordering(&input).expect("rewrites");
        let parsed = parse(&rewritten);
        assert!(parsed.vui_present);
        assert!(parsed.has_restriction);
        assert_eq!(parsed.max_num_ref_frames, 1);
        assert_eq!(rewritten[..4], EMULATOR_SPS[..4]);
    }

    #[test]
    fn adds_a_vui_when_there_is_none() {
        let input = sps_without_vui();
        let parsed_input = parse(&input);
        assert!(!parsed_input.vui_present);

        let rewritten = declare_no_reordering(&input).expect("rewrites");
        let parsed = parse(&rewritten);
        assert!(parsed.vui_present);
        assert!(parsed.has_restriction);
        assert_eq!(parsed.max_num_ref_frames, 1);
    }

    #[test]
    fn declared_values_are_no_reordering() {
        let rewritten = declare_no_reordering(&sps_without_vui()).expect("rewrites");
        let rbsp = unescape(&rewritten[1..]);
        let mut r = BitReader::new(&rbsp);
        let parsed = parse_up_to_restriction(&mut r).expect("parses");
        assert!(r.read_bit().expect("motion vectors flag"));
        assert_eq!(r.read_ue(), Some(2));
        assert_eq!(r.read_ue(), Some(1));
        assert_eq!(r.read_ue(), Some(MAX_LOG2_MV_LENGTH));
        assert_eq!(r.read_ue(), Some(MAX_LOG2_MV_LENGTH));
        assert_eq!(r.read_ue(), Some(0));
        assert_eq!(r.read_ue(), Some(parsed.max_num_ref_frames.max(1)));
    }

    #[test]
    fn ignores_non_sps_and_truncated_input() {
        assert_eq!(declare_no_reordering(&[0x68, 0xce, 0x01, 0xa8]), None);
        assert_eq!(declare_no_reordering(&EMULATOR_SPS[..6]), None);
    }

    #[test]
    fn emulation_prevention_round_trips() {
        let raw = [0x00, 0x00, 0x01, 0x05, 0x00, 0x00, 0x00, 0x00, 0x03];
        let escaped = escape(&raw);
        assert!(escaped.windows(3).all(|w| !(w[0] == 0 && w[1] == 0 && w[2] <= 2)));
        assert_eq!(unescape(&escaped), raw);
    }
}
