"""Prepare a pinned, independent Neo group-text source tree without touching live containers."""
from pathlib import Path
import subprocess
import hashlib
import json

root = Path(__file__).resolve().parent.parent
source = root / 'neo-group-source'
commit = 'aea74c70b9b14438045fd38ab3161ef5c2474095'
if not source.exists():
    origin = 'https://github.com/wechaty/puppet-neo.git'
    subprocess.run(['git','clone','--no-hardlinks',origin,str(source)], check=True)
    subprocess.run(['git','-C',str(source),'checkout','--detach',commit], check=True)
head = subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
if head != commit:
    raise SystemExit('Unexpected Neo source commit; refusing to overwrite.')
manifest = source / '.group-overlay.json'
# neo-group-source is generated; only the named overlay-owned files are rewritten.
def original(name):
    return subprocess.check_output(['git','-C',str(source),'show',commit+':'+name],text=True)
def replace(text,old,new):
    if text.count(old) != 1:
        raise RuntimeError('Pinned source pattern mismatch: '+old[:80])
    return text.replace(old,new,1)

cargo = replace(original('native/Cargo.toml'),'wechat-protocol = "=2.1.0"','wechat-protocol = "=2.1.0"\nroxmltree = "=0.20.0"')
native = original('native/src/lib.rs')
native = replace(native,'use std::{','mod groups;\nmod images;\n\nuse std::{')
native = replace(native,'    time::{Duration, SystemTime, UNIX_EPOCH},','    time::{Duration, Instant, SystemTime, UNIX_EPOCH},\n    collections::HashMap,')
native = replace(native,'    received_cursor: Vec<u8>,','    received_cursor: Vec<u8>,\n    rooms: HashMap<String, groups::RoomView>,\n    room_failures: HashMap<String, Instant>,\n    group_live_since: u32,')
native = replace(native,'    group_live_since: u32,','    group_live_since: u32,\n    pending_images: std::collections::VecDeque<(String, Instant, wechat_protocol::media::MediaDescriptor)>,')
native = replace(native,'    timestamp: u32,','    timestamp: u32,\n    #[serde(skip_serializing_if = "Option::is_none")]\n    room_id: Option<String>,\n    mentions: Vec<String>,\n    #[serde(skip_serializing_if = "Option::is_none")]\n    sender_name: Option<String>,')
native = replace(native,'    sender_name: Option<String>,','    sender_name: Option<String>,\n    image: bool,\n    video: bool,\n    #[serde(skip_serializing_if = "Option::is_none")]\n    quoted_text: Option<String>,\n    #[serde(skip)]\n    descriptor: Option<wechat_protocol::media::MediaDescriptor>,')
native = replace(native,'    LookupSelf,','    DownloadImage { id: String },\n    LookupSelf,')
native = replace(native,'    pub fn lookup_self(&self) -> AsyncTask<NeoTask> {','    pub fn download_image(&self, id: String) -> AsyncTask<NeoTask> {\n        self.task(Operation::DownloadImage { id })\n    }\n\n    #[napi]\n    pub fn lookup_self(&self) -> AsyncTask<NeoTask> {')
native = replace(native,'            Operation::LookupSelf =>','            Operation::DownloadImage { .. } => "download an image",\n            Operation::LookupSelf =>')
native = replace(native,'        run(&mut session, operation).map_err(|error| {','''        let result = match operation {
            Operation::DownloadImage { id } => {
                let prepared = prepare_image(&mut session, &id);
                drop(session);
                prepared.and_then(|(config, descriptor)| images::download(config, descriptor))
            }
            other => run(&mut session, other),
        };
        result.map_err(|error| {''')
native = replace(native,'        Operation::LookupSelf => lookup_self(session),','        Operation::DownloadImage { .. } => Err(anyhow!("Image task must release the session lock")),\n        Operation::LookupSelf => lookup_self(session),')
native = replace(native,'    SendText { destination: String, text: String },','    SendText { destination: String, text: String, mentions: Vec<String> },')
native = replace(native,'    pub fn send_text(&self, destination: String, text: String) -> AsyncTask<NeoTask> {\n        self.task(Operation::SendText { destination, text })\n    }','    pub fn send_text(&self, destination: String, text: String, mentions: Option<Vec<String>>) -> AsyncTask<NeoTask> {\n        self.task(Operation::SendText { destination, text, mentions: mentions.unwrap_or_default() })\n    }')
native = replace(native,'        Operation::SendText { destination, text } => {','''        Operation::SendText { destination, text, mentions } => {
            let source = if destination.ends_with("@chatroom") {
                let own = session.account.as_ref().context("No active session")?.account_identity()?.own_username;
                ensure!(session.rooms.contains_key(&destination), "No observed group");
                ensure!(ensure_room(session, &destination, &own), "Group metadata unavailable");
                groups::mention_source(&mentions, session.rooms.get(&destination).context("No observed group")?)?
            } else {
                ensure!(mentions.is_empty(), "Direct text cannot carry group mentions");
                None
            };''')
native = replace(native,'            wire::text_send_request(&destination, &text, created_at, client_id)?;','            wire::text_send_request_with_source(&destination, &text, created_at, client_id, source.as_deref())?;')
native = replace(native,'                source: None,','                source,')
native = replace(native,'                session.account = Some(NativeClient::from_account(state, options())?);',
    '                session.account = Some(NativeClient::from_account(state, options())?);\n                session.group_live_since = u32::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())?;')
native = replace(native,'    let messages = text_messages(batch.commands, &own);','    let (messages, group_dropped) = text_messages(session, batch.commands, &own);')
native = replace(native,'    Ok(json!({ "messages": messages, "continuation": batch.continuation }))','    Ok(json!({ "messages": messages, "continuation": batch.continuation, "groupDropped": group_dropped }))')
start = native.index('fn text_messages(')
end = native.index('\n#[cfg(test)]',start)
native = native[:start] + '''const IMAGE_DESCRIPTOR_TTL: Duration = Duration::from_secs(90);

fn prepare_image(session: &mut Session, id: &str) -> Result<(wechat_protocol::media::CdnConfig, wechat_protocol::media::MediaDescriptor)> {
    session.pending_images.retain(|(_, at, _)| at.elapsed() <= IMAGE_DESCRIPTOR_TTL);
    let (_, _, descriptor) = session.pending_images.iter().find(|(message_id, _, _)| message_id == id)
        .context("Image message unavailable")?;
    let account = session.account.as_ref().context("No active session")?;
    let config = account.request_blocking(|r| r.cdn_config())?;
    Ok((config, descriptor.clone()))
}
fn ensure_room(session: &mut Session, room_id: &str, own: &str) -> bool {
    let now = Instant::now();
    if session.rooms.get(room_id).is_some_and(|r| r.fetched.elapsed() < Duration::from_secs(300)) { return true; }
    if session.room_failures.get(room_id).is_some_and(|until| *until > now) { return false; }
    let roster = session.account.as_ref()
        .and_then(|a| a.request_blocking(|r| r.lookup_room(room_id, 0)).ok())
        .and_then(|r| groups::RoomView::from_roster(r, own).ok());
    if let Some(view) = roster {
        if session.rooms.len() >= 128 && !session.rooms.contains_key(room_id) {
            if let Some(oldest) = session.rooms.iter().min_by_key(|(_,r)| r.fetched).map(|(id,_)| id.clone()) { session.rooms.remove(&oldest); }
        }
        session.rooms.insert(room_id.into(), view); session.room_failures.remove(room_id); true
    } else {
        session.rooms.remove(room_id);
        if session.room_failures.len() >= 128 {
            if let Some(oldest) = session.room_failures.iter().min_by_key(|(_,until)| **until).map(|(id,_)| id.clone()) { session.room_failures.remove(&oldest); }
        }
        session.room_failures.insert(room_id.into(), now + Duration::from_secs(60)); false
    }
}
fn text_messages(session: &mut Session, commands: Vec<wire::SyncCommand>, username: &str) -> (Vec<TextMessage>, usize) {
    let mut messages = vec![]; let mut dropped = 0;
    for command in commands {
        if command.id != 5 { continue; }
        let Ok(message) = wire::decode_add_message(&command.payload, username) else { continue; };
        if !matches!(message.message_type, 1 | 3 | 43 | 49 | 62) || message.outgoing { continue; }
        let is_group = message.peer.ends_with("@chatroom");
        if (is_group || message.message_type != 1) && message.created_at < session.group_live_since { continue; }
        if is_group && !ensure_room(session, &message.peer, username) { dropped += 1; continue; }
        let room = if is_group { session.rooms.get(&message.peer) } else { None };
        if let Some(mut projected) = groups::project(message, username, room) {
            if let Some(descriptor) = projected.descriptor.take() {
                session.pending_images.retain(|(id, at, _)| *id != projected.id && at.elapsed() <= IMAGE_DESCRIPTOR_TTL);
                if session.pending_images.len() >= 128 { session.pending_images.pop_front(); }
                session.pending_images.push_back((projected.id.clone(), Instant::now(), descriptor));
            }
            messages.push(projected);
        } else if is_group { dropped += 1; }
    }
    (messages, dropped)
}
''' + native[end:]
native = replace(native,'        let messages = text_messages(\n            vec![','        let (messages, _) = text_messages(\n            &mut Session::default(),\n            vec![')

interface = original('src/native.ts')
interface = replace(interface,'  timestamp: number\n}','  timestamp: number\n  roomId?: string\n  mentions?: string[]\n  senderName?: string\n  image?: boolean\n  video?: boolean\n  quotedText?: string\n}')
interface = replace(interface,'  lookupSelf(): Promise<SelfProfile>','  downloadImage?(id: string): Promise<{ mimeType: string, base64: string }>\n  lookupSelf(): Promise<SelfProfile>')
interface = replace(interface,'(...args: Parameters<Session[K]>) => Promise<string>','(...args: Parameters<NonNullable<Session[K]>>) => Promise<string>')
interface = replace(interface,'    lookupSelf: async () =>','    downloadImage: async id => JSON.parse(await addon.downloadImage!(id)),\n    lookupSelf: async () =>')
interface = replace(interface,'  sync(scene: 1 | 6 | 7): Promise<{ messages: IncomingText[], continuation: boolean }>','  sync(scene: 1 | 6 | 7): Promise<{ messages: IncomingText[], continuation: boolean, groupDropped?: number }>')
interface = replace(interface,'  sendText(destination: string, text: string): Promise<{ status:', '  sendText(destination: string, text: string, mentions?: string[]): Promise<{ status:')
interface = replace(interface,'    sendText: async (destination, text) => JSON.parse(await addon.sendText(destination, text)),','    sendText: async (destination, text, mentions) => JSON.parse(await addon.sendText(destination, text, mentions)),')

puppet = original('src/puppet-neo.ts')
puppet = replace(puppet,"  static override readonly VERSION = '0.1.0'", "  static override readonly VERSION = '0.1.0'\n  static readonly GROUP_TEXT = true")
puppet = replace(puppet,'  private readonly messages = new Map<string, payloads.Message>()','  private readonly messages = new Map<string, payloads.Message>()\n  private readonly rooms = new Set<string>()')
puppet = replace(puppet,'      this.messages.clear()','      this.messages.clear()\n      this.rooms.clear()')
puppet = replace(puppet,'  override async messageRawPayload(id:', '''  async downloadImage(id: string) {
    if (!this.online || !this.session?.downloadImage || this.messages.get(id)?.type !== types.Message.Image) {
      throw new Error('Neo image unavailable')
    }
    return this.session.downloadImage(id)
  }

  override async messageRawPayload(id:''')
puppet = replace(puppet,"    if (mentions?.length || destination.endsWith('@chatroom') || !this.contacts.has(destination)) {\n      throw new Error('Neo supports direct text to an observed peer')\n    }\n    const send = this.session.sendText(destination, text)", """    if (destination.endsWith('@chatroom')) {
      if (!this.rooms.has(destination)) throw new Error('Neo supports text to an observed group')
    } else if (mentions?.length || !this.contacts.has(destination)) {
      throw new Error('Neo supports direct text to an observed peer')
    }
    const send = this.session.sendText(destination, text, mentions)""")
puppet = replace(puppet,'        putRecent(this.messages, item.id, {\n          id: item.id, talkerId: item.from, listenerId: item.to,\n          text: item.text, timestamp: item.timestamp, type: types.Message.Text,\n        })', '''        if (item.roomId) {
          this.rooms.delete(item.roomId)
          this.rooms.add(item.roomId)
          if (this.rooms.size > CACHE_LIMIT) this.rooms.delete(this.rooms.values().next().value!)
        }
        const payload: payloads.Message & { neoSenderName?: string, neoQuotedText?: string } = {
          id: item.id, talkerId: item.from, listenerId: item.to,
          text: item.text, timestamp: item.timestamp, type: item.image ? types.Message.Image : item.video ? types.Message.Video : types.Message.Text,
          ...(item.quotedText === undefined ? {} : { neoQuotedText: item.quotedText }),
          ...(item.roomId ? { roomId: item.roomId, mentionIdList: item.mentions ?? [], neoSenderName: item.senderName } : {}),
        }
        putRecent(this.messages, item.id, payload)''')
files = {'native/Cargo.toml':cargo,'native/src/lib.rs':native,'src/native.ts':interface,'src/puppet-neo.ts':puppet}
for path in ['native/src/groups.rs','native/src/images.rs','test/groups.test.ts']:
    files[path] = (root/'neo-overlay'/path).read_text()
record = {}
for name,body in files.items():
    p = source/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(body)
    record[name] = hashlib.sha256(p.read_bytes()).hexdigest()
manifest.write_text(json.dumps(record,indent=2)+'\n')
print('Prepared isolated group source at',source,'commit',commit)
