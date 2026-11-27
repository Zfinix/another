//! Native video path for macOS: VideoToolbox decodes into IOSurfaces that become the contents of a
//! CALayer placed behind the transparent mirror canvas. Frames never pass through the webview, so
//! there is no WebSocket, no WebCodecs and no canvas draw between the decoder and the screen.

use crate::video::{FrameEvent, VideoCodec};
use anyhow::{anyhow, Result};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::msg_send;
use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect, CGSize};
use objc2_core_media::{
    kCMBlockBufferAssureMemoryNowFlag, CMBlockBuffer, CMFormatDescription, CMSampleBuffer, CMTime,
    CMVideoFormatDescriptionCreateFromH264ParameterSets, CMVideoFormatDescriptionCreateFromHEVCParameterSets,
};
use objc2_core_video::{
    kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_32BGRA, CVImageBuffer,
    CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight,
    CVPixelBufferGetIOSurface, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
    CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSNumber, NSString};
use objc2_quartz_core::{kCAGravityResizeAspect, CALayer, CATransaction};
use objc2_video_toolbox::{
    kVTDecompressionPropertyKey_RealTime, VTDecodeFrameFlags, VTDecodeInfoFlags,
    VTDecompressionOutputCallbackRecord, VTDecompressionSession, VTSession, VTSessionSetProperty,
};
use std::collections::VecDeque;
use std::ffi::c_void;
use std::ptr::{self, NonNull};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::WebviewWindow;

const STATS_INTERVAL: Duration = Duration::from_secs(1);
const KEPT_PIXEL_BUFFERS: usize = 2;
const NAL_LENGTH_SIZE: i32 = 4;
const ATTACH_TIMEOUT: Duration = Duration::from_secs(2);
const PROBE_REGION: usize = 16;
const PROBE_THRESHOLD: f64 = 25.0;
const BYTES_PER_PIXEL: usize = 4;

struct SendLayer(Retained<CALayer>);
unsafe impl Send for SendLayer {}
unsafe impl Sync for SendLayer {}

struct Placement {
    layer: Arc<SendLayer>,
    window: WebviewWindow,
}

static PLACEMENT: Mutex<Option<Placement>> = Mutex::new(None);
/// Matches the rounded video frame in the mirror window.
const VIDEO_CORNER_RADIUS: f64 = 12.0;
static FRAME: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);
static ACTIVE: Mutex<Option<Weak<DecodeContext>>> = Mutex::new(None);

struct Probe {
    x: f64,
    y: f64,
    baseline: Vec<u8>,
    seen: Sender<Instant>,
}

#[derive(Default)]
struct Stats {
    frames: u32,
    bytes: usize,
    decode_ms_total: f64,
    lag_ms_total: f64,
    lag_ms_max: f64,
    lag_ms_min: Option<f64>,
    screen_ms_total: f64,
    screen_ms_max: f64,
    screen_samples: u32,
    arrive_ms_total: f64,
    arrive_samples: u32,
    packets: u32,
    lag_baseline: Option<(f64, u64)>,
    last_emit: Option<Instant>,
}

struct FrameContext {
    started: Instant,
    capture_ms: Option<f64>,
}

fn epoch_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

struct DecodeContext {
    layer: Arc<SendLayer>,
    channel: Channel<FrameEvent>,
    stats: Mutex<Stats>,
    shown: Mutex<VecDeque<CFRetained<CVPixelBuffer>>>,
    size: Mutex<(usize, usize)>,
    probe: Mutex<Option<Probe>>,
}

// The pixel buffers are only touched behind the mutexes above, and CoreFoundation retain and
// release are thread-safe, so the context can be shared with VideoToolbox's callback thread.
unsafe impl Send for DecodeContext {}
unsafe impl Sync for DecodeContext {}

pub struct NativeVideo {
    window: WebviewWindow,
    context: Arc<DecodeContext>,
    session: Option<CFRetained<VTDecompressionSession>>,
    format: Option<CFRetained<CMFormatDescription>>,
}

unsafe impl Send for NativeVideo {}

impl NativeVideo {
    pub fn attach(window: WebviewWindow, channel: Channel<FrameEvent>) -> Result<Self> {
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .with_webview(move |webview| {
                let view = webview.inner() as *mut AnyObject;
                let result = unsafe { attach_layer(view) }.map(SendLayer);
                let _ = tx.send(result);
            })
            .map_err(|e| anyhow!("No webview to attach the video layer to: {}", e))?;
        let layer = rx
            .recv_timeout(ATTACH_TIMEOUT)
            .map_err(|_| anyhow!("Timed out attaching the video layer"))?
            .ok_or_else(|| anyhow!("The webview has no layer to attach the video to"))?;
        let layer = Arc::new(layer);

        if let Ok(mut placement) = PLACEMENT.lock() {
            *placement = Some(Placement {
                layer: layer.clone(),
                window: window.clone(),
            });
        }
        reposition();

        let context = Arc::new(DecodeContext {
            layer,
            channel,
            stats: Mutex::new(Stats::default()),
            shown: Mutex::new(VecDeque::with_capacity(KEPT_PIXEL_BUFFERS + 1)),
            size: Mutex::new((0, 0)),
            probe: Mutex::new(None),
        });
        if let Ok(mut active) = ACTIVE.lock() {
            *active = Some(Arc::downgrade(&context));
        }

        Ok(Self {
            window,
            context,
            session: None,
            format: None,
        })
    }

    pub fn configure(&mut self, codec: VideoCodec, parameter_sets: &[&[u8]]) -> Result<()> {
        self.invalidate();
        let format = unsafe { create_format(codec, parameter_sets)? };
        let session = unsafe { create_session(&format, Arc::as_ptr(&self.context))? };
        self.format = Some(format);
        self.session = Some(session);
        Ok(())
    }

    pub fn decode(&mut self, avcc: &[u8], pts: u64, recv_ms: f64, capture_ms: Option<f64>) -> Result<()> {
        let (Some(session), Some(format)) = (&self.session, &self.format) else {
            return Ok(());
        };
        self.record_packet(avcc.len(), pts, recv_ms, capture_ms);
        let sample = unsafe { create_sample(avcc, format)? };
        let started = Box::into_raw(Box::new(FrameContext {
            started: Instant::now(),
            capture_ms,
        }));
        let mut info = VTDecodeInfoFlags::empty();
        let status = unsafe { session.decode_frame(&sample, VTDecodeFrameFlags::empty(), started.cast(), &mut info) };
        if status != 0 {
            drop(unsafe { Box::from_raw(started) });
            return Err(anyhow!("VideoToolbox could not decode a frame ({})", status));
        }
        Ok(())
    }

    fn record_packet(&self, bytes: usize, pts: u64, recv_ms: f64, capture_ms: Option<f64>) {
        let Ok(mut stats) = self.context.stats.lock() else {
            return;
        };
        if let Some(capture_ms) = capture_ms {
            stats.arrive_ms_total += recv_ms - capture_ms;
            stats.arrive_samples += 1;
        }
        stats.bytes += bytes;
        stats.packets += 1;
        let offset = recv_ms - pts as f64 / 1000.0;
        let lag = match stats.lag_baseline {
            Some((base, last_pts)) if pts >= last_pts && offset >= base => {
                stats.lag_baseline = Some((base, pts));
                offset - base
            }
            _ => {
                stats.lag_baseline = Some((offset, pts));
                0.0
            }
        };
        stats.lag_ms_total += lag;
        stats.lag_ms_max = stats.lag_ms_max.max(lag);
        stats.lag_ms_min = Some(stats.lag_ms_min.map_or(lag, |min| min.min(lag)));
    }

    fn invalidate(&mut self) {
        if let Some(session) = self.session.take() {
            unsafe { session.invalidate() };
        }
        self.format = None;
    }
}

impl Drop for NativeVideo {
    fn drop(&mut self) {
        self.invalidate();
        if let Ok(mut placement) = PLACEMENT.lock() {
            if placement
                .as_ref()
                .is_some_and(|p| Arc::ptr_eq(&p.layer, &self.context.layer))
            {
                *placement = None;
            }
        }
        let layer = self.context.layer.clone();
        let _ = self.window.with_webview(move |_| {
            layer.0.removeFromSuperlayer();
        });
    }
}

/// Takes the video layer off the webview right away, so the last frame never lingers behind the
/// translucent window once mirroring stops. Dropping the decoder later is then a no-op.
pub fn detach() {
    let Some(placement) = PLACEMENT.lock().ok().and_then(|mut p| p.take()) else {
        return;
    };
    let layer = placement.layer.clone();
    let _ = placement.window.with_webview(move |_| {
        layer.0.removeFromSuperlayer();
    });
}

/// Watches decoded frames for a change around (x, y), given as fractions of the frame size. The
/// receiver gets the moment the first changed frame was put on the layer.
pub fn arm_probe(x: f64, y: f64) -> Result<Receiver<Instant>> {
    let context = ACTIVE
        .lock()
        .ok()
        .and_then(|active| active.as_ref().and_then(Weak::upgrade))
        .ok_or_else(|| anyhow!("Native video is not running"))?;
    let latest = context
        .shown
        .lock()
        .ok()
        .and_then(|shown| shown.back().cloned())
        .ok_or_else(|| anyhow!("No frame on screen yet"))?;
    let baseline = unsafe { sample_region(&latest, x, y) }.ok_or_else(|| anyhow!("Could not read the frame"))?;
    let (seen, receiver) = std::sync::mpsc::channel();
    if let Ok(mut probe) = context.probe.lock() {
        *probe = Some(Probe { x, y, baseline, seen });
    }
    Ok(receiver)
}

pub fn disarm_probe() {
    let context = ACTIVE.lock().ok().and_then(|active| active.as_ref().and_then(Weak::upgrade));
    if let Some(context) = context {
        if let Ok(mut probe) = context.probe.lock() {
            *probe = None;
        }
    }
}

unsafe fn sample_region(pixel_buffer: &CVPixelBuffer, x: f64, y: f64) -> Option<Vec<u8>> {
    if CVPixelBufferLockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly) != 0 {
        return None;
    }
    let base = CVPixelBufferGetBaseAddress(pixel_buffer) as *const u8;
    let stride = CVPixelBufferGetBytesPerRow(pixel_buffer);
    let width = CVPixelBufferGetWidth(pixel_buffer);
    let height = CVPixelBufferGetHeight(pixel_buffer);
    let region = if base.is_null() || width < PROBE_REGION || height < PROBE_REGION {
        None
    } else {
        let left = ((x * width as f64) as usize).saturating_sub(PROBE_REGION / 2).min(width - PROBE_REGION);
        let top = ((y * height as f64) as usize).saturating_sub(PROBE_REGION / 2).min(height - PROBE_REGION);
        let mut out = Vec::with_capacity(PROBE_REGION * PROBE_REGION * BYTES_PER_PIXEL);
        for row in top..top + PROBE_REGION {
            let start = base.add(row * stride + left * BYTES_PER_PIXEL);
            out.extend_from_slice(std::slice::from_raw_parts(start, PROBE_REGION * BYTES_PER_PIXEL));
        }
        Some(out)
    };
    CVPixelBufferUnlockBaseAddress(pixel_buffer, CVPixelBufferLockFlags::ReadOnly);
    region
}

fn mean_difference(a: &[u8], b: &[u8]) -> f64 {
    let total: u64 = a
        .chunks_exact(BYTES_PER_PIXEL)
        .zip(b.chunks_exact(BYTES_PER_PIXEL))
        .map(|(p, q)| (0..3).map(|i| u64::from(p[i].abs_diff(q[i]))).sum::<u64>())
        .sum();
    total as f64 / (a.len() / BYTES_PER_PIXEL).max(1) as f64 / 3.0
}

pub fn set_frame(x: f64, y: f64, width: f64, height: f64) {
    if let Ok(mut frame) = FRAME.lock() {
        *frame = Some((x, y, width, height));
    }
    reposition();
}

fn reposition() {
    let Some(frame) = FRAME.lock().ok().and_then(|f| *f) else {
        return;
    };
    let Some((layer, window)) = PLACEMENT
        .lock()
        .ok()
        .and_then(|p| p.as_ref().map(|p| (p.layer.clone(), p.window.clone())))
    else {
        return;
    };
    let _ = window.with_webview(move |webview| unsafe {
        let view = webview.inner() as *mut AnyObject;
        let Some(view) = view.as_ref() else {
            return;
        };
        let bounds: CGRect = msg_send![view, bounds];
        let flipped: bool = msg_send![view, isFlipped];
        let (x, top, width, height) = frame;
        let y = if flipped { top } else { bounds.size.height - top - height };
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        layer.0.setFrame(CGRect::new(CGPoint::new(x, y), CGSize::new(width, height)));
        CATransaction::commit();
    });
}

unsafe fn attach_layer(view: *mut AnyObject) -> Option<Retained<CALayer>> {
    let view = view.as_ref()?;
    let host: Option<Retained<CALayer>> = msg_send![view, layer];
    let host = host?;
    let layer = CALayer::new();
    layer.setContentsGravity(kCAGravityResizeAspect);
    layer.setOpaque(true);
    layer.setCornerRadius(VIDEO_CORNER_RADIUS);
    layer.setMasksToBounds(true);
    host.insertSublayer_atIndex(&layer, 0);
    set_draws_background(view as *const AnyObject as *mut AnyObject, false);
    Some(layer)
}

unsafe fn set_draws_background(view: *mut AnyObject, draws: bool) {
    let Some(view) = view.as_ref() else {
        return;
    };
    let value = NSNumber::new_bool(draws);
    let key = NSString::from_str("drawsBackground");
    let _: () = msg_send![view, setValue: &*value, forKey: &*key];
}

unsafe fn create_format(codec: VideoCodec, parameter_sets: &[&[u8]]) -> Result<CFRetained<CMFormatDescription>> {
    if parameter_sets.is_empty() {
        return Err(anyhow!("No parameter sets in the config packet"));
    }
    let mut pointers: Vec<NonNull<u8>> = parameter_sets
        .iter()
        .map(|set| NonNull::new(set.as_ptr() as *mut u8).ok_or_else(|| anyhow!("Empty parameter set")))
        .collect::<Result<_>>()?;
    let mut sizes: Vec<usize> = parameter_sets.iter().map(|set| set.len()).collect();
    let mut format: *const CMFormatDescription = ptr::null();
    let status = match codec {
        VideoCodec::H264 => CMVideoFormatDescriptionCreateFromH264ParameterSets(
            None,
            pointers.len(),
            NonNull::new_unchecked(pointers.as_mut_ptr()),
            NonNull::new_unchecked(sizes.as_mut_ptr()),
            NAL_LENGTH_SIZE,
            NonNull::from(&mut format),
        ),
        VideoCodec::H265 => CMVideoFormatDescriptionCreateFromHEVCParameterSets(
            None,
            pointers.len(),
            NonNull::new_unchecked(pointers.as_mut_ptr()),
            NonNull::new_unchecked(sizes.as_mut_ptr()),
            NAL_LENGTH_SIZE,
            None,
            NonNull::from(&mut format),
        ),
    };
    let format = NonNull::new(format as *mut CMFormatDescription)
        .filter(|_| status == 0)
        .ok_or_else(|| anyhow!("CoreMedia rejected the parameter sets ({})", status))?;
    Ok(CFRetained::from_raw(format))
}

unsafe fn create_session(
    format: &CMFormatDescription,
    context: *const DecodeContext,
) -> Result<CFRetained<VTDecompressionSession>> {
    let pixel_format = CFNumber::new_i32(kCVPixelFormatType_32BGRA as i32);
    let surface_properties: CFRetained<CFDictionary<CFString, CFType>> = CFDictionary::from_slices(&[], &[]);
    let attributes: CFRetained<CFDictionary<CFString, CFType>> = CFDictionary::from_slices(
        &[kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferIOSurfacePropertiesKey],
        &[pixel_format.as_ref(), surface_properties.as_ref()],
    );
    let callback = VTDecompressionOutputCallbackRecord {
        decompressionOutputCallback: Some(on_decoded),
        decompressionOutputRefCon: context as *mut c_void,
    };
    let mut session: *mut VTDecompressionSession = ptr::null_mut();
    let status = VTDecompressionSession::create(
        None,
        format,
        None,
        Some(attributes.as_opaque()),
        &callback,
        NonNull::from(&mut session),
    );
    let session = NonNull::new(session)
        .filter(|_| status == 0)
        .ok_or_else(|| anyhow!("VideoToolbox could not create a decoder ({})", status))?;
    let session = CFRetained::from_raw(session);
    let as_session = &*(CFRetained::as_ptr(&session).as_ptr() as *const VTSession);
    VTSessionSetProperty(as_session, kVTDecompressionPropertyKey_RealTime, Some(CFBoolean::new(true).as_ref()));
    Ok(session)
}

unsafe fn create_sample(avcc: &[u8], format: &CMFormatDescription) -> Result<CFRetained<CMSampleBuffer>> {
    let mut block: *mut CMBlockBuffer = ptr::null_mut();
    let status = CMBlockBuffer::create_with_memory_block(
        None,
        ptr::null_mut(),
        avcc.len(),
        None,
        ptr::null(),
        0,
        avcc.len(),
        kCMBlockBufferAssureMemoryNowFlag,
        NonNull::from(&mut block),
    );
    let block = NonNull::new(block)
        .filter(|_| status == 0)
        .ok_or_else(|| anyhow!("CoreMedia could not allocate a block buffer ({})", status))?;
    let block = CFRetained::from_raw(block);
    let data = NonNull::new(avcc.as_ptr() as *mut c_void).ok_or_else(|| anyhow!("Empty packet"))?;
    let status = CMBlockBuffer::replace_data_bytes(data, &block, 0, avcc.len());
    if status != 0 {
        return Err(anyhow!("CoreMedia could not fill a block buffer ({})", status));
    }

    let mut sample: *mut CMSampleBuffer = ptr::null_mut();
    let size = avcc.len();
    let status = CMSampleBuffer::create_ready(
        None,
        Some(&block),
        Some(format),
        1,
        0,
        ptr::null(),
        1,
        &size,
        NonNull::from(&mut sample),
    );
    let sample = NonNull::new(sample)
        .filter(|_| status == 0)
        .ok_or_else(|| anyhow!("CoreMedia could not wrap a sample ({})", status))?;
    Ok(CFRetained::from_raw(sample))
}

unsafe extern "C-unwind" fn on_decoded(
    context: *mut c_void,
    frame_context: *mut c_void,
    status: i32,
    _flags: VTDecodeInfoFlags,
    image: *mut CVImageBuffer,
    _pts: CMTime,
    _duration: CMTime,
) {
    let frame = (!frame_context.is_null()).then(|| *Box::from_raw(frame_context as *mut FrameContext));
    let Some(context) = (context as *const DecodeContext).as_ref() else {
        return;
    };
    let Some(image) = NonNull::new(image) else {
        return;
    };
    if status != 0 {
        return;
    }
    let pixel_buffer: CFRetained<CVPixelBuffer> = CFRetained::retain(image.cast());
    let Some(surface) = CVPixelBufferGetIOSurface(Some(&pixel_buffer)) else {
        return;
    };

    CATransaction::begin();
    CATransaction::setDisableActions(true);
    context
        .layer
        .0
        .setContents(Some(&*(CFRetained::as_ptr(&surface).as_ptr() as *const AnyObject)));
    CATransaction::commit();
    let shown_epoch_ms = epoch_ms();

    let shown_at = Instant::now();
    if let Ok(mut probe) = context.probe.lock() {
        let changed = probe.as_ref().is_some_and(|p| {
            sample_region(&pixel_buffer, p.x, p.y)
                .is_some_and(|now| mean_difference(&p.baseline, &now) > PROBE_THRESHOLD)
        });
        if changed {
            if let Some(p) = probe.take() {
                let _ = p.seen.send(shown_at);
            }
        }
    }

    let width = CVPixelBufferGetWidth(&pixel_buffer);
    let height = CVPixelBufferGetHeight(&pixel_buffer);
    if let Ok(mut shown) = context.shown.lock() {
        shown.push_back(pixel_buffer);
        while shown.len() > KEPT_PIXEL_BUFFERS {
            shown.pop_front();
        }
    }
    if let Ok(mut size) = context.size.lock() {
        if *size != (width, height) {
            *size = (width, height);
            let _ = context.channel.send(FrameEvent::NativeSize {
                width: width as u32,
                height: height as u32,
            });
        }
    }
    context.record_frame(frame, shown_epoch_ms);
}

impl DecodeContext {
    fn record_frame(&self, frame: Option<FrameContext>, shown_epoch_ms: f64) {
        let Ok(mut stats) = self.stats.lock() else {
            return;
        };
        stats.frames += 1;
        if let Some(frame) = frame {
            stats.decode_ms_total += frame.started.elapsed().as_secs_f64() * 1000.0;
            if let Some(capture_ms) = frame.capture_ms {
                let screen_ms = shown_epoch_ms - capture_ms;
                stats.screen_ms_total += screen_ms;
                stats.screen_ms_max = stats.screen_ms_max.max(screen_ms);
                stats.screen_samples += 1;
            }
        }
        let now = Instant::now();
        let last = *stats.last_emit.get_or_insert(now);
        let elapsed = now.duration_since(last);
        if elapsed < STATS_INTERVAL {
            return;
        }
        let secs = elapsed.as_secs_f64();
        let _ = self.channel.send(FrameEvent::NativeStats {
            fps: (stats.frames as f64 / secs).round() as u32,
            decode_ms: if stats.frames > 0 { stats.decode_ms_total / stats.frames as f64 } else { 0.0 },
            kbps: (stats.bytes as f64 * 8.0 / secs / 1000.0).round() as u32,
            lag_ms: if stats.packets > 0 { stats.lag_ms_total / stats.packets as f64 } else { 0.0 },
            lag_max_ms: stats.lag_ms_max,
            lag_min_ms: stats.lag_ms_min.unwrap_or(0.0),
            screen_ms: if stats.screen_samples > 0 { stats.screen_ms_total / stats.screen_samples as f64 } else { 0.0 },
            screen_max_ms: stats.screen_ms_max,
            arrive_ms: if stats.arrive_samples > 0 { stats.arrive_ms_total / stats.arrive_samples as f64 } else { 0.0 },
        });
        let baseline = stats.lag_baseline;
        *stats = Stats {
            lag_baseline: baseline,
            last_emit: Some(now),
            ..Stats::default()
        };
    }
}
