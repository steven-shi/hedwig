//! Narrow group-text projection for the supported AddMsg profile.
//! No raw message/source/roster data is written to logs.
use super::TextMessage;
use anyhow::{ensure, Result};
use std::collections::HashMap;
use std::time::Instant;
use wechat_protocol::wire;

fn xml_child<'a, 'input>(node: roxmltree::Node<'a, 'input>, name: &str) -> Option<roxmltree::Node<'a, 'input>> {
    let mut matches = node.children().filter(|child| child.has_tag_name(name));
    let child = matches.next()?;
    matches.next().is_none().then_some(child)
}

fn xml_text(node: roxmltree::Node<'_, '_>) -> Option<String> {
    if node.children().any(|child| child.is_element()) { return None; }
    let value: String = node.children().filter(|child| child.is_text()).filter_map(|child| child.text()).collect();
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn quote_reply(raw: &str) -> Option<(String, Option<String>)> {
    if raw.len() > 65_536 { return None; }
    let options = roxmltree::ParsingOptions { allow_dtd: false, ..Default::default() };
    let document = roxmltree::Document::parse_with_options(raw, options).ok()?;
    let root = document.root_element();
    if !root.has_tag_name("msg") { return None; }
    let app = xml_child(root, "appmsg")?;
    if xml_text(xml_child(app, "type")?)? != "57" { return None; }
    let title = xml_text(xml_child(app, "title")?)?;
    let quoted = xml_child(app, "refermsg").and_then(|reference| {
        if xml_text(xml_child(reference, "type")?)? != "1" { return None; }
        let content = xml_text(xml_child(reference, "content")?)?;
        // Bound by UTF-16 units consistently with the JavaScript bridge.
        let mut units = 0;
        Some(content.chars().take_while(|c| {
            units += c.len_utf16();
            units <= 2000
        }).collect())
    });
    Some((title, quoted))
}

pub(super) struct RoomView {
    pub(super) members: HashMap<String, String>,
    pub(super) fetched: Instant,
}
pub(super) fn valid_member(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.ends_with("@chatroom")
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-@".contains(&b))
}
impl RoomView {
    pub(super) fn from_roster(roster: wire::RoomRoster, own: &str) -> Result<Self> {
        let mut members = HashMap::new();
        for member in roster.members {
            ensure!(valid_member(&member.username), "Invalid group member");
            let label = member.room_display_name.filter(|v| !v.is_empty())
                .or(member.nickname.filter(|v| !v.is_empty())).unwrap_or_else(|| member.username.clone());
            members.insert(member.username, label);
        }
        for id in roster.full_member_ids.unwrap_or_default() {
            ensure!(valid_member(&id), "Invalid group member");
            members.entry(id.clone()).or_insert(id);
        }
        ensure!(members.contains_key(own), "Own account missing from group roster");
        Ok(Self { members, fetched: Instant::now() })
    }
}
pub(super) fn parse_mentions(source: Option<&[u8]>) -> Result<Vec<String>> {
    let Some(raw) = source else { return Ok(vec![]); };
    ensure!(raw.len() <= 65536, "Group source too large");
    let text = std::str::from_utf8(raw)?;
    if text.trim().is_empty() { return Ok(vec![]); }
    let options = roxmltree::ParsingOptions { allow_dtd: false, ..Default::default() };
    let document = roxmltree::Document::parse_with_options(text, options)?;
    let root = document.root_element();
    ensure!(root.tag_name().name() == "msgsource" && root.tag_name().namespace().is_none(), "Invalid group source");
    let lists: Vec<_> = root.children().filter(|n| n.is_element() && n.tag_name().name() == "atuserlist").collect();
    ensure!(lists.len() <= 1, "Ambiguous mention metadata");
    let Some(node) = lists.first() else { return Ok(vec![]); };
    ensure!(node.tag_name().namespace().is_none() && node.attributes().len() == 0 && !node.children().any(|n| n.is_element()), "Invalid mention metadata");
    let value: String = node.children().filter(|n| n.is_text()).filter_map(|n| n.text()).collect();
    let mut result = vec![];
    for id in value.split(',').map(str::trim).filter(|id| !id.is_empty()) {
        ensure!(valid_member(id) && result.len() < 256, "Invalid mention identity");
        if !result.iter().any(|v| v == id) { result.push(id.to_string()); }
    }
    Ok(result)
}
pub(super) fn mention_source(mentions: &[String], room: &RoomView) -> Result<Option<String>> {
    ensure!(mentions.len() <= 8, "Too many group mentions");
    for id in mentions {
        ensure!(valid_member(id) && room.members.contains_key(id), "Mention is not a known group member");
    }
    Ok((!mentions.is_empty()).then(|| format!(
        "<msgsource><atuserlist><![CDATA[{}]]></atuserlist></msgsource>", mentions.join(",")
    )))
}
pub(super) fn project(message: wire::AddMessage, own: &str, room: Option<&RoomView>) -> Option<TextMessage> {
    let id = message.server_message_id?;
    let raw = message.content_text?;
    if message.outgoing { return None; }
    let (from, to, text, room_id, mentions, sender_name) = if message.peer.ends_with("@chatroom") {
        if message.from != message.peer || message.to != own { return None; }
        let view = room?;
        let (sender, text) = raw.split_once(":\n")?;
        if !valid_member(sender) || sender == own { return None; }
        let label = view.members.get(sender)?.clone();
        let mentions = parse_mentions(message.msgsource.as_deref()).unwrap_or_default()
            .into_iter().filter(|id| view.members.contains_key(id)).collect();
        (sender.to_owned(), own.to_owned(), text, Some(message.peer), mentions, Some(label))
    } else {
        (message.from, message.to, raw.as_str(), None, vec![], None)
    };
    let mut projected = TextMessage {
        id, from, to, text: String::new(), timestamp: message.created_at,
        room_id, mentions, sender_name, image: false, video: false, quoted_text: None, descriptor: None,
    };
    match message.message_type {
        1 => projected.text = text.to_owned(),
        3 => {
            projected.descriptor = Some(super::images::descriptor(text)?);
            projected.image = true;
        }
        43 | 62 => projected.video = true,
        49 => (projected.text, projected.quoted_text) = quote_reply(text)?,
        _ => return None,
    }
    Some(projected)
}
#[cfg(test)]
mod tests {
    use super::*;
    use wechat_protocol::protobuf as p;
    fn view() -> RoomView {
        RoomView { members: [("bot".into(), "Bot".into()), ("alice".into(), "Alice".into()), ("bob".into(), "Bob".into())].into(), fetched: Instant::now() }
    }
    fn message(from: &str, content: &str, source: Option<&str>, kind: u64) -> wire::AddMessage {
        let mut fields = vec![
            p::uint(1, 1), p::bytes(2, &p::bytes(1, from.as_bytes())), p::bytes(3, &p::bytes(1, b"bot")),
            p::uint(4, kind), p::bytes(5, &p::bytes(1, content.as_bytes())), p::uint(6, 0), p::uint(7, 0),
            p::bytes(8, &p::buffer(&[])), p::uint(9, 123456), p::uint(12, 98765432109876),
        ];
        if let Some(s) = source { fields.push(p::bytes(10, s.as_bytes())); }
        wire::decode_add_message(&p::message(&fields).unwrap(), "bot").unwrap()
    }
    #[test]
    fn group_sender_and_real_mentions_are_projected_separately_from_room() {
        let room = view();
        let projected = project(message("room@chatroom", "alice:\n@Bot hi", Some("<msgsource><atuserlist><![CDATA[bot,bob]]></atuserlist></msgsource>"), 1), "bot", Some(&room)).unwrap();
        assert_eq!(projected.from, "alice"); assert_eq!(projected.room_id.as_deref(), Some("room@chatroom"));
        assert_eq!(projected.text, "@Bot hi"); assert_eq!(projected.sender_name.as_deref(), Some("Alice"));
        assert_eq!(projected.mentions, ["bot", "bob"]);
    }
    #[test]
    fn visible_at_text_without_metadata_does_not_become_a_mention() {
        let room = view();
        let projected = project(message("room@chatroom", "alice:\n@Bot hi", None, 1), "bot", Some(&room)).unwrap();
        assert!(projected.mentions.is_empty());
    }
    #[test]
    fn image_projection_preserves_group_routing_without_serializing_media_metadata() {
        let room = view();
        let xml = "alice:\n<msg><img cdnmidimgurl=\"fixture-cdn-id\" length=\"700\" aeskey=\"00000000000000000000000000000000\"/></msg>";
        let projected = project(message("room@chatroom", xml, None, 3), "bot", Some(&room)).unwrap();
        assert!(projected.image && projected.descriptor.is_some());
        assert_eq!(projected.from, "alice");
        assert!(projected.text.is_empty());
        let serialized = serde_json::to_string(&projected).unwrap();
        assert!(!serialized.contains("fixture-cdn-id"));
        assert!(!serialized.contains("aeskey"));
    }
    #[test]
    fn unresolved_group_sender_missing_envelope_and_nontext_are_not_projected() {
        let room = view();
        assert!(project(message("room@chatroom", "outsider:\nhello", None, 1), "bot", Some(&room)).is_none());
        assert!(project(message("room@chatroom", "hello", None, 1), "bot", Some(&room)).is_none());
        assert!(project(message("room@chatroom", "alice:\nhello", None, 1), "bot", None).is_none());
        assert!(project(message("room@chatroom", "bot:\nhello", None, 1), "bot", Some(&room)).is_none());
        assert!(project(message("room@chatroom", "alice:\nimage", None, 3), "bot", Some(&room)).is_none());
    }
    #[test]
    fn xml_is_strict_and_does_not_expand_external_entities() {
        assert!(parse_mentions(Some(b"<!DOCTYPE msgsource [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><msgsource><atuserlist>&x;</atuserlist></msgsource>")).is_err());
        assert!(parse_mentions(Some(b"<msgsource><atuserlist>bot</atuserlist><atuserlist>alice</atuserlist></msgsource>")).is_err());
        assert!(parse_mentions(Some(b"<msgsource><atuserlist><nested>bot</nested></atuserlist></msgsource>")).is_err());
        assert_eq!(parse_mentions(Some(b"<msgsource><atuserlist>bot_suffix</atuserlist></msgsource>")).unwrap(), ["bot_suffix"]);
    }
    #[test]
    fn reply_mentions_are_validated_and_encoded_in_protocol_source() {
        let room = view(); let source = mention_source(&["alice".into()], &room).unwrap().unwrap();
        assert_eq!(parse_mentions(Some(source.as_bytes())).unwrap(), ["alice"]);
        assert!(mention_source(&["outsider".into()], &room).is_err());
        assert!(mention_source(&["alice]]>".into()], &room).is_err());
        assert!(mention_source(&[], &room).unwrap().is_none());
    }
    #[test]
    fn private_text_projection_is_unchanged() {
        let projected = project(message("alice", "hello", None, 1), "bot", None).unwrap();
        assert_eq!(projected.from, "alice"); assert_eq!(projected.text, "hello"); assert!(projected.room_id.is_none());
    }
    #[test]
    fn quote_keeps_current_text_and_reference_separate() {
        let room = view();
        let raw = "alice:\n<msg><appmsg><title>@Bot 解一下</title><type>57</type><refermsg><type>1</type><content>8 &lt; 9 &amp; <![CDATA[题目]]></content></refermsg></appmsg></msg>";
        let source = Some("<msgsource><atuserlist>bot</atuserlist></msgsource>");
        let quote = project(message("room@chatroom", raw, source, 49), "bot", Some(&room)).unwrap();
        assert_eq!(quote.text, "@Bot 解一下");
        assert_eq!(quote.quoted_text.as_deref(), Some("8 < 9 & 题目"));
        assert_eq!(quote.mentions, ["bot"]);
    }
    #[test]
    fn unrelated_app_messages_and_dtd_are_rejected() {
        assert!(quote_reply("<msg><appmsg><type>5</type><title>link</title></appmsg></msg>").is_none());
        assert!(quote_reply("<!DOCTYPE msg [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><msg><appmsg><type>57</type><title>&x;</title></appmsg></msg>").is_none());
        assert_eq!(quote_reply("<msg><appmsg><type>57</type><title>hello</title><refermsg><type>43</type><content>fixture-video-metadata</content></refermsg></appmsg></msg>"), Some(("hello".into(), None)));
    }
    #[test]
    fn video_projection_excludes_raw_payload() {
        let video = project(message("alice", "fixture-video-metadata", None, 43), "bot", None).unwrap();
        assert!(video.video && !video.image && video.descriptor.is_none());
        assert!(!serde_json::to_string(&video).unwrap().contains("fixture-video-metadata"));
    }
}

#[cfg(test)]
mod roster_tests {
    use super::*;
    #[test]
    fn group_roster_must_include_our_account() {
        let make = |ids: Vec<String>| wire::RoomRoster {
            room_id: "room@chatroom".into(), version: 1, members: vec![],
            full_member_ids: Some(ids), owner: None, administrator_ids: None,
        };
        assert!(RoomView::from_roster(make(vec!["alice".into()]), "bot").is_err());
        let room = RoomView::from_roster(make(vec!["alice".into(), "bot".into()]), "bot").unwrap();
        assert!(room.members.contains_key("alice"));
    }
}
