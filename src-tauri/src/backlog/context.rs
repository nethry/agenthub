//! The context pack: what an agent learns about the backlog when a chat starts
//! from an item. The current item goes in full (with its saved plan), related
//! items in full while they fit, and every other open item as one line, so a
//! plan takes the rest of the backlog into account without the whole backlog
//! in every prompt. It is stored on the user message (`ItemBody::BacklogContext`)
//! and shown as a chip, never sent behind the user's back.

use super::{repository, BacklogItem, Status};
use crate::chat::images::MAX_IMAGES;
use crate::error::AppResult;
use crate::persistence::Db;

/// The whole pack, about 6k tokens.
pub const BACKLOG_CONTEXT_CHARS: usize = 24_000;
/// The current item's description and plan, each.
const CURRENT_TEXT_CHARS: usize = 8_000;
/// A related item's description and plan, together.
const RELATED_TEXT_CHARS: usize = 3_000;
/// One line per other open item.
const LINE_CHARS: usize = 160;

fn cut(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push_str("\n[…cut to fit]");
    out
}

fn first_line(text: &str) -> &str {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("")
}

fn one_line(text: &str, max: usize) -> String {
    let line = first_line(text).trim_start_matches(['#', '-', '*', ' ']).trim();
    if line.chars().count() <= max {
        line.to_string()
    } else {
        let mut s: String = line.chars().take(max.saturating_sub(1)).collect();
        s.push('…');
        s
    }
}

fn heading(item: &BacklogItem) -> String {
    format!("{} · {} · {} · {} priority", item.key(), item.kind.label(), item.status.label(item.kind), item.priority.label())
}

/// Work in progress first, then by priority, then newest.
fn rank(item: &BacklogItem) -> (u8, u8, i64) {
    let status = match item.status {
        Status::InProgress => 0,
        Status::Review => 1,
        Status::Planned => 2,
        Status::Open => 3,
        Status::Done | Status::Dropped => 4,
    };
    let priority = match item.priority {
        super::Priority::High => 0,
        super::Priority::Normal => 1,
        super::Priority::Low => 2,
    };
    (status, priority, -item.seq)
}

fn attr(s: &str) -> String {
    s.chars().filter(|c| !matches!(c, '"' | '<' | '>' | '\n' | '\r')).collect()
}

/// Builds the pack for `current` from the project's items (`all` may include it).
pub fn pack(project: &str, current: &BacklogItem, all: &[BacklogItem], budget: usize) -> String {
    let mut out = format!("<backlog_context project=\"{}\">\n", attr(project));
    out.push_str(
        "This chat works on one item of the project's backlog in AgentHub. The other items are context only: \
         don't work on them, but keep your work compatible with them and point out conflicts or groundwork they share.\n\n",
    );
    out.push_str(&format!("## Current item: {}\n\nTitle: {}\n\n", heading(current), current.title));
    let body = cut(&current.body, CURRENT_TEXT_CHARS);
    out.push_str(&format!("### Description\n\n{}\n\n", if body.is_empty() { "(none)" } else { &body }));
    if let Some(plan) = current.plan.as_deref().filter(|p| !p.trim().is_empty()) {
        out.push_str(&format!("### Saved plan\n\n{}\n\n", cut(plan, CURRENT_TEXT_CHARS)));
    }
    match current.images.len() {
        0 => {}
        n if n <= MAX_IMAGES => out.push_str(&format!("The item has {n} screenshot(s); they are attached to this message unless the user removed them.\n\n")),
        n => out.push_str(&format!("The item has {n} screenshots; at most {MAX_IMAGES} (the newest) are attached to a message.\n\n")),
    }

    let close = "</backlog_context>";
    let others: Vec<&BacklogItem> = {
        let mut v: Vec<&BacklogItem> = all.iter().filter(|i| i.id != current.id && i.project_id == current.project_id).collect();
        v.sort_by_key(|i| rank(i));
        v
    };
    let related: Vec<&BacklogItem> = current.related.iter().filter_map(|id| others.iter().copied().find(|i| &i.id == id)).collect();
    let mut related_shown: Vec<&str> = Vec::new();
    if !related.is_empty() {
        let mut section = String::from("## Related items\n\n");
        for item in &related {
            let mut text = format!("### {} — {}\n\n", heading(item), item.title);
            let mut detail = item.body.trim().to_string();
            if let Some(plan) = item.plan.as_deref().filter(|p| !p.trim().is_empty()) {
                detail.push_str(&format!("\n\nSaved plan:\n{}", plan.trim()));
            }
            let detail = cut(&detail, RELATED_TEXT_CHARS);
            if !detail.is_empty() {
                text.push_str(&detail);
                text.push_str("\n\n");
            }
            if out.len() + section.len() + text.len() + close.len() > budget {
                break;
            }
            section.push_str(&text);
            related_shown.push(&item.id);
        }
        if !related_shown.is_empty() {
            out.push_str(&section);
        }
    }

    let open: Vec<&BacklogItem> = others.iter().copied().filter(|i| i.status.is_open() && !related_shown.contains(&i.id.as_str())).collect();
    if !open.is_empty() {
        let mut section = String::from("## Other open items\n\n");
        let mut left_out = 0;
        for (n, item) in open.iter().enumerate() {
            let mut line = format!("- {} [{} · {}] {}", item.key(), item.status.label(item.kind), item.priority.label(), one_line(&item.title, LINE_CHARS));
            let gist = one_line(&item.body, LINE_CHARS);
            if !gist.is_empty() {
                line.push_str(&format!(" — {gist}"));
            }
            if let Some(plan) = item.plan.as_deref().map(|p| one_line(p, LINE_CHARS)).filter(|p| !p.is_empty()) {
                line.push_str(&format!("; plan: {plan}"));
            }
            line.push('\n');
            // Keep room for the "more items" note.
            if out.len() + section.len() + line.len() + close.len() + 64 > budget {
                left_out = open.len() - n;
                break;
            }
            section.push_str(&line);
        }
        if left_out > 0 {
            section.push_str(&format!("- ({left_out} more open item{} not listed)\n", if left_out == 1 { "" } else { "s" }));
        }
        out.push_str(&section);
        out.push('\n');
    }
    out.push_str(close);
    out
}

/// The pack for an item, from the database.
pub fn for_item(db: &Db, item_id: &str) -> AppResult<(BacklogItem, String)> {
    let item = repository::get(db, item_id)?;
    let project = crate::projects::get(db, &item.project_id)?;
    let all = repository::list(db, &item.project_id)?;
    let text = pack(&project.name, &item, &all, BACKLOG_CONTEXT_CHARS);
    Ok((item, text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backlog::{BacklogImage, Kind, Priority};

    fn item(seq: i64, kind: Kind, status: Status, priority: Priority, title: &str, body: &str) -> BacklogItem {
        BacklogItem {
            id: format!("id-{seq}"),
            project_id: "p".into(),
            seq,
            kind,
            title: title.into(),
            body: body.into(),
            status,
            priority,
            plan: None,
            related: vec![],
            images: vec![],
            links: vec![],
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn current_in_full_others_as_ordered_lines_without_closed_ones() {
        let mut cur = item(1, Kind::Feature, Status::Planned, Priority::High, "Dark mode", "Goal\n\nAll views dark.");
        cur.plan = Some("1. Tokens\n2. Views".into());
        let all = vec![
            cur.clone(),
            item(2, Kind::Bug, Status::Open, Priority::Normal, "Crash on save", "\n## Steps\nSave twice"),
            item(3, Kind::Feature, Status::InProgress, Priority::Low, "Themes", "Custom themes"),
            item(4, Kind::Feature, Status::Done, Priority::High, "Shipped", "x"),
            item(5, Kind::Bug, Status::Dropped, Priority::High, "Ignored", "x"),
            item(6, Kind::Feature, Status::Open, Priority::High, "Search", ""),
        ];
        let text = pack("My \"App\"", &cur, &all, BACKLOG_CONTEXT_CHARS);
        assert!(text.starts_with("<backlog_context project=\"My App\">"), "{text}");
        assert!(text.ends_with("</backlog_context>"));
        assert!(text.contains("## Current item: FEAT-1 · Feature · Planned · High priority"));
        assert!(text.contains("All views dark."));
        assert!(text.contains("### Saved plan\n\n1. Tokens\n2. Views"));
        let lines: Vec<&str> = text.lines().filter(|l| l.starts_with("- ")).collect();
        assert_eq!(
            lines,
            vec![
                "- FEAT-3 [In progress · Low] Themes — Custom themes",
                "- FEAT-6 [Idea · High] Search",
                "- BUG-2 [Reported · Normal] Crash on save — Steps",
            ]
        );
        assert!(!text.contains("Shipped") && !text.contains("Ignored"), "done and dropped items are left out");
    }

    #[test]
    fn related_items_in_full_and_the_budget_cuts_lines_with_a_note() {
        let mut cur = item(1, Kind::Bug, Status::Open, Priority::Normal, "Bug", "Steps");
        cur.related = vec!["id-2".into()];
        cur.images = (0..6).map(|i| BacklogImage { id: format!("i{i}"), name: "s".into(), mime: "image/png".into(), size: 1, created_at: 0 }).collect();
        let mut all = vec![cur.clone()];
        let mut rel = item(2, Kind::Feature, Status::Planned, Priority::Normal, "Related one", "Full related body");
        rel.plan = Some("Related plan".into());
        all.push(rel);
        for seq in 3..200 {
            all.push(item(seq, Kind::Feature, Status::Open, Priority::Normal, &format!("Item {seq}"), &"word ".repeat(40)));
        }
        let text = pack("P", &cur, &all, 4_000);
        assert!(text.len() <= 4_000, "{}", text.len());
        assert!(text.contains("## Related items\n\n### FEAT-2 · Feature · Planned · Normal priority — Related one\n\nFull related body\n\nSaved plan:\nRelated plan"));
        assert!(!text.contains("- FEAT-2 "), "a related item isn't listed twice");
        assert!(text.contains("more open items not listed)"), "{text}");
        assert!(text.contains("6 screenshots; at most 4"));
    }

    #[test]
    fn long_text_is_cut_on_char_boundaries() {
        let cur = item(1, Kind::Feature, Status::Open, Priority::Normal, "Ü", &"ü".repeat(CURRENT_TEXT_CHARS + 10));
        let text = pack("P", &cur, std::slice::from_ref(&cur), BACKLOG_CONTEXT_CHARS);
        assert!(text.contains("[…cut to fit]"));
    }
}
