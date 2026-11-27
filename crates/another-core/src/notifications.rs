use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PhoneNotification {
    pub key: String,
    pub package: String,
    pub title: String,
    pub text: String,
    pub posted_ms: u64,
}

const SKIPPED_FLAGS: [&str; 3] = ["ONGOING_EVENT", "FOREGROUND_SERVICE", "GROUP_SUMMARY"];
const SYSTEM_PACKAGES: [&str; 2] = ["android", "com.android.systemui"];

/// Parses `dumpsys notification --noredact` into the notifications a person would see in the shade.
pub fn parse_dumpsys(output: &str) -> Vec<PhoneNotification> {
    let mut found: Vec<PhoneNotification> = Vec::new();
    let mut current: Option<PhoneNotification> = None;
    let mut skip = false;

    let flush = |record: Option<PhoneNotification>, skip: bool, found: &mut Vec<PhoneNotification>| {
        if let Some(record) = record {
            let visible = !skip && !record.title.is_empty() && !SYSTEM_PACKAGES.contains(&record.package.as_str());
            if visible && !found.iter().any(|n| n.key == record.key) {
                found.push(record);
            }
        }
    };

    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("NotificationRecord(") {
            flush(current.take(), skip, &mut found);
            skip = false;
            let package = field(rest, "pkg=").unwrap_or_default();
            let key = rest
                .split(" key=")
                .nth(1)
                .and_then(|k| k.split(": Notification(").next())
                .unwrap_or_default()
                .to_string();
            current = Some(PhoneNotification { key, package, title: String::new(), text: String::new(), posted_ms: 0 });
            continue;
        }
        let Some(record) = current.as_mut() else {
            continue;
        };
        if let Some(flags) = trimmed.strip_prefix("flags=") {
            if SKIPPED_FLAGS.iter().any(|f| flags.split('|').any(|x| x == *f)) {
                skip = true;
            }
        } else if let Some(value) = extra(trimmed, "android.title=") {
            record.title = value;
        } else if let Some(value) = extra(trimmed, "android.text=") {
            record.text = value;
        } else if let Some(value) = trimmed.strip_prefix("mCreationTimeMs=") {
            record.posted_ms = value.trim().parse().unwrap_or(0);
        }
    }
    flush(current.take(), skip, &mut found);
    found.sort_by(|a, b| b.posted_ms.cmp(&a.posted_ms));
    found
}

fn field(haystack: &str, name: &str) -> Option<String> {
    let start = haystack.find(name)? + name.len();
    haystack[start..].split_whitespace().next().map(str::to_string)
}

fn extra(line: &str, name: &str) -> Option<String> {
    let value = line.strip_prefix(name)?;
    let open = value.find('(')?;
    let close = value.rfind(')')?;
    (close > open).then(|| value[open + 1..close].trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
    NotificationRecord(0x0774de5b: pkg=android user=UserHandle{-1} id=2147483647 tag=ranker_group importance=2 key=-1|android|2147483647|ranker_group|1000|ranker_group: Notification(channel=X flags=ONGOING_EVENT|GROUP_SUMMARY))
      flags=ONGOING_EVENT|LOCAL_ONLY|GROUP_SUMMARY|AUTOGROUP_SUMMARY
      mCreationTimeMs=1795766264336
    NotificationRecord(0x0c2407d1: pkg=com.google.android.gm user=UserHandle{0} id=19 tag=null importance=3 key=0|com.google.android.gm|19|null|10123: Notification(channel=mail flags=AUTO_CANCEL))
      flags=AUTO_CANCEL
                android.title=String (Your sign-in code)
                android.text=SpannableString (482913 is your code (expires soon))
      mCreationTimeMs=1795766264084
    NotificationRecord(0x0c2407d2: pkg=com.whatsapp user=UserHandle{0} id=4 tag=null importance=4 key=0|com.whatsapp|4|null|10200: Notification(channel=msg flags=AUTO_CANCEL))
      flags=AUTO_CANCEL
                android.title=String (Family)
                android.text=null
      mCreationTimeMs=1795766269000
    NotificationRecord(0x0c2407d1: pkg=com.google.android.gm user=UserHandle{0} id=19 tag=null importance=3 key=0|com.google.android.gm|19|null|10123: Notification(channel=mail flags=AUTO_CANCEL))
      flags=AUTO_CANCEL
                android.title=String (Your sign-in code)
      mCreationTimeMs=1795766264084
";

    #[test]
    fn parse_dumpsys_skips_ongoing_and_system_records() {
        let parsed = parse_dumpsys(SAMPLE);
        assert_eq!(parsed.len(), 2);
        assert!(parsed.iter().all(|n| n.package != "android"));
    }

    #[test]
    fn parse_dumpsys_reads_title_text_and_nested_parentheses() {
        let parsed = parse_dumpsys(SAMPLE);
        let gmail = parsed.iter().find(|n| n.package == "com.google.android.gm").unwrap();
        assert_eq!(gmail.title, "Your sign-in code");
        assert_eq!(gmail.text, "482913 is your code (expires soon)");
        assert_eq!(gmail.key, "0|com.google.android.gm|19|null|10123");
    }

    #[test]
    fn parse_dumpsys_orders_newest_first_and_dedupes_keys() {
        let parsed = parse_dumpsys(SAMPLE);
        assert_eq!(parsed[0].package, "com.whatsapp");
        assert_eq!(parsed[0].text, "");
    }
}
