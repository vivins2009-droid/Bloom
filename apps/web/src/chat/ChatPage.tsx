import { ArrowLeft, ImagePlus, LifeBuoy, MessageCircle, Send, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { Account, ChatAttachment, ChatConversation, ChatMessage } from '@bloom/contracts';
import { api, apiBaseUrl, chatSocketUrl } from '../api';
import { Field, Notice, SelectField, Spinner } from '../components';

type PreparedImage = { name: string; dataUrl: string; mediaType: 'image/webp'; width: number; height: number };

const timeLabel = (value: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(value));

async function prepareImage(file: File): Promise<PreparedImage> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG, or WebP image.');
  if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} is larger than 5 MB.`);
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale)); const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height); bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('The image could not be prepared.')), 'image/webp', .86));
  const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
  return { name: file.name, dataUrl, mediaType: 'image/webp', width, height };
}

function MessageAttachment({ id }: { id: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => { api<{ url: string }>(`/chat/attachments/${id}/access`).then((result) => setUrl(result.url.startsWith('http') ? result.url : `${apiBaseUrl}${result.url}`)).catch(() => setUrl('')); }, [id]);
  return url ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="Conversation attachment" /></a> : <span className="chat-image-placeholder">Image unavailable</span>;
}

export function ChatPage({ account, admin = false }: { account: Account; admin?: boolean }) {
  const [conversations, setConversations] = useState<ChatConversation[] | null>(null); const [activeId, setActiveId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[] | null>(null); const [text, setText] = useState(''); const [images, setImages] = useState<PreparedImage[]>([]);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [showList, setShowList] = useState(true); const endRef = useRef<HTMLDivElement>(null);
  const [accounts, setAccounts] = useState<Account[]>([]); const [supportOpen, setSupportOpen] = useState(false); const [supportAccountId, setSupportAccountId] = useState(''); const [moderating, setModerating] = useState<ChatMessage | null>(null); const [moderationReason, setModerationReason] = useState('');
  const active = conversations?.find((conversation) => conversation.id === activeId);
  const loadConversations = async (selectFirst = false) => {
    try { const { data } = await api<{ data: ChatConversation[] }>('/chat/conversations'); setConversations(data); if ((selectFirst || !activeId) && data[0]) setActiveId(data[0].id); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Conversations could not be loaded.'); }
  };
  const loadMessages = async (quiet = false) => {
    if (!activeId) { setMessages([]); return; }
    try { const { data } = await api<{ data: ChatMessage[] }>(`/chat/conversations/${activeId}/messages?limit=100`); setMessages(data); await api(`/chat/conversations/${activeId}/read`, { method: 'POST' }); if (!quiet) setError(''); }
    catch (cause) { if (!quiet) setError(cause instanceof Error ? cause.message : 'Messages could not be loaded.'); }
  };
  useEffect(() => { void loadConversations(true); const timer = window.setInterval(() => void loadConversations(), 15000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { if (admin) void api<{ data: Account[] }>('/admin/accounts').then(({ data }) => { setAccounts(data); setSupportAccountId(data[0]?.id ?? ''); }).catch(() => undefined); }, [admin]);
  useEffect(() => {
    let socket: WebSocket | undefined; let retry = 0; let closed = false;
    const connect = () => {
      socket = new WebSocket(chatSocketUrl);
      socket.onopen = () => { retry = 0; };
      socket.onmessage = (event) => { try { if (JSON.parse(String(event.data)).type === 'session.revoked') { window.location.assign('/'); return; } } catch { /* refresh from REST below */ } void loadConversations(); void loadMessages(true); };
      socket.onclose = () => { if (!closed) window.setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++)); };
    };
    connect(); return () => { closed = true; socket?.close(); };
  }, [activeId]);
  useEffect(() => { setMessages(null); void loadMessages(); const timer = window.setInterval(() => void loadMessages(true), 15000); return () => window.clearInterval(timer); }, [activeId]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages]);
  const grouped = useMemo(() => ({ support: conversations?.filter((item) => item.type === 'ADMIN_SUPPORT') ?? [], pickup: conversations?.filter((item) => item.type === 'PICKUP' && item.state === 'OPEN') ?? [], history: conversations?.filter((item) => item.type === 'PICKUP' && item.state === 'READ_ONLY') ?? [] }), [conversations]);
  const startSupport = async () => { setBusy(true); try { const conversation = await api<ChatConversation>('/chat/support', { method: 'POST', body: '{}' }); await loadConversations(); setActiveId(conversation.id); setShowList(false); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Support could not be opened.'); } finally { setBusy(false); } };
  const startAdminSupport = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { const conversation = await api<ChatConversation>('/chat/support', { method: 'POST', body: JSON.stringify({ accountId: supportAccountId }) }); setSupportOpen(false); await loadConversations(); setActiveId(conversation.id); setShowList(false); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Support could not be opened.'); } finally { setBusy(false); } };
  const moderate = async (event: FormEvent) => { event.preventDefault(); if (!moderating) return; setBusy(true); try { await api(`/admin/chat/messages/${moderating.id}/hide`, { method: 'POST', body: JSON.stringify({ reason: moderationReason }) }); setModerating(null); setModerationReason(''); await loadMessages(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The message could not be hidden.'); } finally { setBusy(false); } };
  const chooseFiles = async (event: ChangeEvent<HTMLInputElement>) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length + images.length > 4) { setError('Attach no more than four images to a message.'); return; } try { const prepared = await Promise.all(files.map(prepareImage)); setImages((current) => [...current, ...prepared]); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : 'An image could not be prepared.'); } };
  const send = async (event: FormEvent) => {
    event.preventDefault(); if (!active || (!text.trim() && !images.length)) return; setBusy(true); setError('');
    try {
      const attachments: ChatAttachment[] = [];
      for (const image of images) attachments.push(await api(`/chat/conversations/${active.id}/attachments`, { method: 'POST', body: JSON.stringify(image) }));
      await api(`/chat/conversations/${active.id}/messages`, { method: 'POST', body: JSON.stringify({ text: text.trim(), attachmentIds: attachments.map((item) => item.id), idempotencyKey: crypto.randomUUID() }) });
      setText(''); setImages([]); await Promise.all([loadMessages(), loadConversations()]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The message could not be sent. Your draft is still here.'); } finally { setBusy(false); }
  };
  const join = async () => { if (!active) return; setBusy(true); try { await api(`/admin/chat/conversations/${active.id}/join`, { method: 'POST' }); await Promise.all([loadMessages(), loadConversations()]); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The conversation could not be joined.'); } finally { setBusy(false); } };
  const renderGroup = (label: string, items: ChatConversation[]) => items.length ? <section className="chat-conversation-group"><h3>{label}</h3>{items.map((conversation) => <button key={conversation.id} className={activeId === conversation.id ? 'active' : ''} onClick={() => { setActiveId(conversation.id); setShowList(false); }}><span>{conversation.type === 'ADMIN_SUPPORT' ? <LifeBuoy size={17} /> : <MessageCircle size={17} />}</span><div><strong>{conversation.title}</strong><small>{conversation.lastMessage?.text || 'Conversation ready'}</small></div>{conversation.unreadCount > 0 && <b aria-label={`${conversation.unreadCount} unread`}>{conversation.unreadCount}</b>}</button>)}</section> : null;
  return <main className={`page chat-page ${showList ? '' : 'chat-page--detail'}`}><section className="page-heading chat-heading"><div><p className="eyebrow">Private coordination</p><h1>Chat</h1><p>Coordinate active collections or speak privately with Bloom administrators.</p></div>{admin ? <button className="button button--quiet" disabled={busy || !accounts.length} onClick={() => setSupportOpen(true)}><LifeBuoy size={17} /> Start support</button> : !grouped.support.length && <button className="button button--quiet" disabled={busy} onClick={startSupport}><LifeBuoy size={17} /> Contact Admin</button>}</section>{error && <Notice tone="error"><span>{error}</span><button onClick={() => { void loadConversations(); void loadMessages(); }}>Try again</button></Notice>}
    <section className="chat-workspace"><aside className="chat-list" aria-label="Conversations">{!conversations ? <Spinner label="Loading conversations" /> : conversations.length ? <>{renderGroup('Support', grouped.support)}{renderGroup('Active pickups', grouped.pickup)}{renderGroup('Closed history', grouped.history)}</> : <div className="chat-empty"><MessageCircle size={24} /><h2>No conversations yet</h2><p>Pickup conversations appear as soon as a recovery partner reserves a collection.</p>{!admin && <button className="text-link" onClick={startSupport}>Contact Admin</button>}</div>}</aside>
      <article className="chat-thread">{active ? <><header><button className="chat-back" onClick={() => setShowList(true)} aria-label="Back to conversations"><ArrowLeft size={19} /></button><div><h2>{active.title}</h2><p>{active.type === 'PICKUP' ? 'Bloom administrators have disclosed operational access to this conversation.' : 'Private support with Bloom administrators.'}</p></div>{admin && active.type === 'PICKUP' && !active.adminJoinedAt && <button className="button button--quiet" disabled={busy} onClick={join}><ShieldCheck size={16} /> Join visibly</button>}</header><div className="chat-messages" aria-live="polite">{messages === null ? <Spinner label="Loading messages" /> : messages.map((message) => <div className={`chat-message ${message.kind.toLowerCase()} ${message.senderAccountId === account.id ? 'mine' : ''}`} key={message.id}>{message.kind !== 'SYSTEM' && <span>{message.senderOrganizationName} · {message.senderDisplayName}</span>}<p>{message.text}</p>{message.attachmentIds.length > 0 && <div className="chat-attachments">{message.attachmentIds.map((id) => <MessageAttachment id={id} key={id} />)}</div>}<div className="chat-message-meta"><time>{timeLabel(message.createdAt)}</time>{admin && message.kind === 'MESSAGE' && !message.hiddenAt && <button onClick={() => setModerating(message)}>Hide message</button>}</div></div>)}<div ref={endRef} /></div>{admin && active.type === 'PICKUP' && !active.adminJoinedAt ? <div className="chat-read-only"><ShieldCheck size={18} /><span>Join visibly before sending a message to these participants.</span></div> : active.state === 'READ_ONLY' ? <div className="chat-read-only"><ShieldCheck size={18} /><span>This conversation is read-only. Its collection closed more than seven days ago.</span></div> : <form className="chat-composer" onSubmit={send}>{images.length > 0 && <div className="chat-image-queue">{images.map((image, index) => <span key={`${image.name}-${index}`}>{image.name}<button type="button" aria-label={`Remove ${image.name}`} onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button></span>)}</div>}<div><label className="chat-attach"><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={chooseFiles} disabled={busy} /><ImagePlus size={20} /><span className="sr-only">Attach images</span></label><textarea aria-label="Message" value={text} onChange={(event) => setText(event.target.value)} placeholder="Write a message" maxLength={2000} rows={1} /><button className="chat-send" disabled={busy || (!text.trim() && !images.length)} aria-label="Send message"><Send size={19} /></button></div><small>{text.length}/2,000 · up to four images</small></form>}</> : <div className="chat-thread-empty"><MessageCircle size={30} /><h2>Select a conversation</h2><p>Messages and collection context will appear here.</p></div>}</article>
    </section>{supportOpen && <div className="dialog-backdrop"><form className="dialog chat-dialog" role="dialog" aria-modal="true" aria-labelledby="start-support-title" onSubmit={startAdminSupport}><button type="button" className="dialog-close" onClick={() => setSupportOpen(false)} aria-label="Close"><X size={18} /></button><p className="eyebrow">Private support</p><h2 id="start-support-title">Choose an organization</h2><p>Open its persistent private conversation with Bloom administrators.</p><Field label="Organization"><SelectField value={supportAccountId} onChange={(event) => setSupportAccountId(event.target.value)}>{accounts.map((item) => <option value={item.id} key={item.id}>{item.organizationName}</option>)}</SelectField></Field><div className="form-actions"><button type="button" className="button button--quiet" onClick={() => setSupportOpen(false)}>Cancel</button><button className="button button--primary" disabled={busy || !supportAccountId}>Open support</button></div></form></div>}{moderating && <div className="dialog-backdrop"><form className="dialog chat-dialog" role="dialog" aria-modal="true" aria-labelledby="moderate-message-title" onSubmit={moderate}><button type="button" className="dialog-close" onClick={() => setModerating(null)} aria-label="Close"><X size={18} /></button><p className="eyebrow">Content moderation</p><h2 id="moderate-message-title">Hide this message?</h2><p>Participants will see a moderation notice. The reason and action remain in the administrative audit record.</p><Field label="Reason"><textarea rows={3} minLength={3} maxLength={300} value={moderationReason} onChange={(event) => setModerationReason(event.target.value)} required /></Field><div className="form-actions"><button type="button" className="button button--quiet" onClick={() => setModerating(null)}>Keep message</button><button className="button button--danger" disabled={busy || moderationReason.trim().length < 3}>Hide message</button></div></form></div>}</main>;
}
