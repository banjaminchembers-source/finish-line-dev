import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, AudioLines, Bot, Check, CircleHelp, Clock3, History, Mic, MicOff,
  Plus, RotateCw, Send, Settings2, Sparkles, Square, Trash2, Volume2, X,
} from 'lucide-react';
import { useChatStatus, useSendChatMessage } from '@/lib/chat-client';
import { cleanForSpeech, pickRussianVoice, voiceGender } from '@/lib/speech';
import { signInWithGoogle, signOut, useAuthUser, useCloudSync } from '@/lib/cloud-sync';

type ChatRole = 'user' | 'assistant' | 'notice' | 'error';
type ChatEntry = { id: string; role: ChatRole; content: string; time: number; localOnly?: boolean };
type Conversation = { id: string; title: string; messages: ChatEntry[]; updatedAt: number };
type ConversationStore = { threads: Conversation[]; currentId: string };
type Preferences = { autoSpeak: boolean; voiceRate: number };
type RecognitionResult = { 0: { transcript: string }; isFinal: boolean };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type RecognitionInstance = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void; stop: () => void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => RecognitionInstance;
  webkitSpeechRecognition?: new () => RecognitionInstance;
};

const LEGACY_THREAD_KEY = 'brain.current-thread.v1';
const THREADS_KEY = 'brain.conversations.v1';
const CURRENT_THREAD_KEY = 'brain.current-conversation.v1';
const PREFS_KEY = 'brain.preferences.v1';
const defaultPrefs: Preferences = { autoSpeak: false, voiceRate: 1 };
const suggestions = [
  { title: 'Собери мысли в план', detail: 'Преврати задачу в понятные шаги', prompt: 'Помоги составить план действий для моей задачи.' },
  { title: 'Объясни простыми словами', detail: 'Разберись в сложной теме без лишнего', prompt: 'Объясни простыми словами, как работает машинное обучение.' },
  { title: 'Напиши лучше', detail: 'Сформулируй сообщение или письмо', prompt: 'Помоги написать короткое и вежливое сообщение.' },
];

function deriveTitle(messages: ChatEntry[]): string {
  const firstMessage = messages.find((message) => message.role === 'user')?.content.trim();
  if (!firstMessage) return 'Новый разговор';
  return firstMessage.length > 42 ? `${firstMessage.slice(0, 42).trimEnd()}…` : firstMessage;
}

function createConversation(messages: ChatEntry[] = []): Conversation {
  const latest = messages.reduce((time, message) => Math.max(time, message.time), 0);
  return {
    id: `thread-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: deriveTitle(messages),
    messages,
    updatedAt: latest || Date.now(),
  };
}

function cleanMessages(value: unknown): ChatEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ChatEntry =>
    item && typeof item.id === 'string' &&
    ['user', 'assistant', 'notice', 'error'].includes(item.role) &&
    typeof item.content === 'string' && typeof item.time === 'number',
  ).slice(-80);
}

function loadConversations(): ConversationStore {
  try {
    const saved = localStorage.getItem(THREADS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        const threads = parsed.filter((thread) => thread && typeof thread.id === 'string')
          .map((thread): Conversation => {
            const messages = cleanMessages(thread.messages);
            return {
              id: thread.id,
              title: deriveTitle(messages),
              messages,
              updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : Date.now(),
            };
          });
        if (threads.length) {
          const requestedId = localStorage.getItem(CURRENT_THREAD_KEY);
          return { threads, currentId: threads.some((thread) => thread.id === requestedId) ? requestedId! : threads[0]!.id };
        }
      }
    }
    const legacyMessages = cleanMessages(JSON.parse(localStorage.getItem(LEGACY_THREAD_KEY) ?? '[]'));
    const firstThread = createConversation(legacyMessages);
    return { threads: [firstThread], currentId: firstThread.id };
  } catch {
    const firstThread = createConversation();
    return { threads: [firstThread], currentId: firstThread.id };
  }
}

function readPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return {
      autoSpeak: typeof value.autoSpeak === 'boolean' ? value.autoSpeak : defaultPrefs.autoSpeak,
      voiceRate: typeof value.voiceRate === 'number' ? Math.min(1.5, Math.max(.7, value.voiceRate)) : defaultPrefs.voiceRate,
    };
  } catch { return defaultPrefs; }
}

function makeEntry(role: ChatRole, content: string): ChatEntry {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role, content, time: Date.now() };
}

function isDeviceCommand(text: string): boolean {
  const value = text.toLocaleLowerCase('ru-RU').replace(/[ё]/g, 'е');
  const opensDevice = ['открой', 'откройте', 'запусти', 'запустите', 'перейди в', 'перейдите в', 'включи', 'включите', 'позвони', 'позвоните', 'набери'].some((phrase) => value.includes(phrase));
  const deviceTarget = ['youtube', 'ютуб', 'настройк', 'камер', 'приложени', 'вайбер', 'whatsapp', 'телеграм', 'telegram', 'инстаграм', 'instagram', 'галере', 'bluetooth', 'блютуз', 'телефон', 'контакт'];
  const searchIntent = ['найди', 'найти', 'поищи', 'поищите', 'посмотри', 'поиск', 'ищи'].some((phrase) => value.includes(phrase));
  const onlineTarget = ['интернет', 'в сети', 'браузер', 'сайт', 'онлайн'].some((phrase) => value.includes(phrase));
  return (opensDevice && deviceTarget.some((target) => value.includes(target)))
    || (searchIntent && onlineTarget);
}

function formatTime(time: number): string {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(time);
}

export function BrainApp() {
  const [conversationState, setConversationState] = useState<ConversationStore>(loadConversations);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(readPreferences);
  const [draft, setDraft] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [speechError, setSpeechError] = useState('');
  const [requestError, setRequestError] = useState('');
  const [voiceAvailable, setVoiceAvailable] = useState(true);
  const [preferredVoice, setPreferredVoice] = useState<SpeechSynthesisVoice | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<RecognitionInstance | null>(null);
  const recognitionBaseRef = useRef('');
  const currentThread = conversationState.threads.find((thread) => thread.id === conversationState.currentId) ?? conversationState.threads[0]!;
  const currentThreadId = currentThread.id;
  const messages = currentThread.messages;
  const statusQuery = useChatStatus();
  const sendMessage = useSendChatMessage();
  const status = statusQuery.data;
  const { user, ready: authReady } = useAuthUser();
  const syncState = useCloudSync(user?.id ?? null, conversationState, setConversationState);
  const [authError, setAuthError] = useState('');
  const handleSignIn = async () => { setAuthError(''); const err = await signInWithGoogle(); if (err) setAuthError(err); };

  const updateMessages = (threadId: string, update: (entries: ChatEntry[]) => ChatEntry[]) => {
    setConversationState((current) => ({
      ...current,
      threads: current.threads.map((thread) => {
        if (thread.id !== threadId) return thread;
        const nextMessages = update(thread.messages);
        return { ...thread, messages: nextMessages, title: deriveTitle(nextMessages), updatedAt: Date.now() };
      }),
    }));
  };

  useEffect(() => {
    try {
      localStorage.setItem(THREADS_KEY, JSON.stringify(conversationState.threads));
      localStorage.setItem(CURRENT_THREAD_KEY, conversationState.currentId);
    } catch { /* Local storage may be unavailable. */ }
  }, [conversationState]);
  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(preferences)); } catch { /* Local storage may be unavailable. */ }
  }, [preferences]);
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sendMessage.isPending]);

  useEffect(() => {
    if (!('speechSynthesis' in window)) { setVoiceAvailable(false); return; }
    const chooseVoice = () => setPreferredVoice(pickRussianVoice(window.speechSynthesis.getVoices()));
    chooseVoice();
    window.speechSynthesis.addEventListener('voiceschanged', chooseVoice);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', chooseVoice);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false);
        setHistoryOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const speechRunRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speak = useCallback(async (text: string) => {
    const run = ++speechRunRef.current;
    audioRef.current?.pause();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    const clean = cleanForSpeech(text).slice(0, 4500);
    if (!clean) return;
    setSpeechError('');
    setSpeaking(true);
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean, speed: preferences.voiceRate }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Ошибка ${res.status}`);
      const blob = await res.blob();
      if (run !== speechRunRef.current) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); if (run === speechRunRef.current) setSpeaking(false); };
      await audio.play();
    } catch (error) {
      if (run !== speechRunRef.current) return;
      console.warn('Adam voice unavailable', error);
      setSpeaking(false);
      setSpeechError('Не удалось воспроизвести выбранный голос Adam. Проверьте подключение ElevenLabs. Системный голос не включён, чтобы Dima не менял голос сам.');
    }
  }, [preferences.voiceRate]);

  const stopSpeaking = () => {
    speechRunRef.current++;
    audioRef.current?.pause();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  };

  const startListening = () => {
    setSpeechError('');
    const browser = window as SpeechWindow;
    const Recognition = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if (!Recognition) {
      setSpeechError('Голосовой ввод не поддерживается. Попробуйте открыть Dima в актуальном браузере.');
      return;
    }
    try {
      const recognition = new Recognition();
      recognition.lang = 'ru-RU';
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.onresult = (event) => {
        let spoken = '';
        for (let i = 0; i < event.results.length; i += 1) spoken += (event.results[i]?.[0].transcript ?? "");
        if (spoken) setDraft(`${recognitionBaseRef.current}${recognitionBaseRef.current ? ' ' : ''}${spoken}`.trim());
      };
      recognition.onerror = (event) => {
        setListening(false);
        setSpeechError(event.error === 'not-allowed'
          ? 'Нет доступа к микрофону. Разрешите его в настройках браузера.'
          : 'Не удалось распознать речь. Проверьте микрофон и попробуйте ещё раз.');
      };
      recognition.onend = () => setListening(false);
      recognitionRef.current = recognition;
      recognitionBaseRef.current = draft.trim();
      recognition.start();
      setListening(true);
    } catch {
      setListening(false);
      setSpeechError('Не удалось включить микрофон. Попробуйте ещё раз.');
    }
  };

  const toggleListening = () => {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
    } else startListening();
  };

  const submitMessage = async (value = draft) => {
    const content = value.trim();
    if (!content || sendMessage.isPending) return;
    const targetThreadId = currentThreadId;
    setDraft('');
    setRequestError('');
    const isUnsupported = isDeviceCommand(content);
    const userEntry = { ...makeEntry('user', content), localOnly: isUnsupported };
    updateMessages(targetThreadId, (current) => [...current, userEntry]);

    if (isUnsupported) {
      updateMessages(targetThreadId, (current) => [...current, makeEntry('notice', 'Я работаю внутри браузера и не могу открывать приложения Android, менять настройки телефона или управлять устройством. Запросы на поиск в интернете тоже не выполняю. Могу помочь с вопросом или подготовить инструкцию, которую вы откроете самостоятельно.')]);
      return;
    }
    if (statusQuery.isLoading) {
      updateMessages(targetThreadId, (current) => current.map((entry) => entry.id === userEntry.id ? { ...entry, localOnly: true } : entry));
      setRequestError('Подключение ещё проверяется. Попробуйте отправить сообщение чуть позже.');
      return;
    }
    if (!status?.configured) {
      updateMessages(targetThreadId, (current) => current.map((entry) => entry.id === userEntry.id ? { ...entry, localOnly: true } : entry));
      const message = statusQuery.isError
        ? 'Не удалось проверить подключение к ИИ. Проверьте соединение и повторите попытку.'
        : 'Подключение к ИИ не настроено. Сообщение сохранено только на этом устройстве; попросите администратора настроить провайдера ИИ.';
      setRequestError(message);
      return;
    }

    const history = [...messages.filter((entry) => !entry.localOnly && (entry.role === 'user' || entry.role === 'assistant')).map(({ role, content: itemContent }) => ({ role: role as 'user' | 'assistant', content: itemContent })), { role: 'user' as const, content }];
    try {
      const response = await sendMessage.mutateAsync({ data: { messages: history.slice(-39) } });
      const assistantText = response?.message?.content;
      if (typeof assistantText !== 'string' || !assistantText.trim()) {
        setRequestError('Сервис не вернул ответ. Попробуйте отправить сообщение ещё раз.');
        return;
      }
      updateMessages(targetThreadId, (current) => [...current, makeEntry('assistant', assistantText)]);
      if (preferences.autoSpeak) speak(assistantText);
    } catch (error) {
      const apiError = error as { message?: string; data?: { error?: string }; response?: { data?: { error?: string } } };
      const serverText = apiError.data?.error ?? apiError.response?.data?.error;
      const message = typeof serverText === 'string' && /not configured|не настроен|configuration/i.test(serverText)
        ? 'Подключение к ИИ не настроено. Обратитесь к администратору, чтобы настроить провайдера.'
        : 'Не удалось получить ответ от ИИ. Проверьте подключение и повторите попытку.';
      setRequestError(message);
    }
  };

  const clearConversation = () => {
    if (!window.confirm('Очистить текущий разговор? Будут удалены только его сообщения; остальные разговоры останутся сохранены.')) return;
    stopSpeaking();
    recognitionRef.current?.stop();
    setListening(false);
    updateMessages(currentThreadId, () => []);
    setRequestError('');
    setDraft('');
  };

  const newConversation = () => {
    stopSpeaking();
    recognitionRef.current?.stop();
    setListening(false);
    const conversation = createConversation();
    setConversationState((current) => ({ threads: [conversation, ...current.threads], currentId: conversation.id }));
    setRequestError('');
    setDraft('');
    setHistoryOpen(false);
  };

  const openConversation = (threadId: string) => {
    stopSpeaking();
    setConversationState((current) => ({ ...current, currentId: threadId }));
    setRequestError('');
    setDraft('');
    setHistoryOpen(false);
  };

  const updatePreference = (next: Partial<Preferences>) => setPreferences((current) => ({ ...current, ...next }));

  return (
    <div className="app-shell">
      <div className="layout">
        <header className="topbar">
          <div className="brand" aria-label="Dima — личный ИИ-ассистент">
            <div className="brand-mark"><AudioLines size={19} strokeWidth={1.8} /></div>
            <div><div className="brand-name">Dima</div><div className="brand-caption">Личное пространство</div></div>
          </div>
          <div className="top-actions">
            <div className="statusline header-status" data-testid="status-ai-connection">
              <span className={`status-dot ${statusQuery.isLoading ? 'waiting' : status?.configured ? 'ready' : ''}`} />
              <span>{statusQuery.isLoading ? 'Проверяем подключение' : statusQuery.isError ? 'Нет связи с сервером' : status?.configured ? 'ИИ на связи' : 'ИИ не настроен'}</span>
            </div>
            {authReady && (user
              ? <button className="soft-button" onClick={() => void signOut()} data-testid="button-sign-out" title={user.email ?? ''} aria-label="Выйти из аккаунта">
                  <span>{syncState === 'loading' ? 'Загружаем историю…' : syncState === 'error' ? 'Ошибка сохранения' : 'История в аккаунте'} · Выйти</span>
                </button>
              : <button className="soft-button" onClick={() => void handleSignIn()} data-testid="button-sign-in" aria-label="Войти через Google">
                  <span>Войти через Google</span>
                </button>)}
            <button className="soft-button" onClick={newConversation} data-testid="button-new-conversation" aria-label="Начать новый разговор">
              <Plus size={16} /> <span>Новый разговор</span>
            </button>
            <button className="icon-button" onClick={() => setHistoryOpen(true)} data-testid="button-open-history" aria-label="Открыть историю разговоров">
              <History size={18} />
            </button>
            <button className="icon-button clear-current-button" onClick={clearConversation} data-testid="button-clear-current-thread" aria-label="Очистить текущий разговор" title="Очистить текущий разговор">
              <Trash2 size={17} />
            </button>
            <button className="icon-button" onClick={() => setSettingsOpen(true)} data-testid="button-open-settings" aria-label="Открыть настройки">
              <Settings2 size={18} />
            </button>
          </div>
        </header>

        <main className="main">
          {statusQuery.isLoading && <div className="error-card" style={{ borderColor: '#292c37', color: '#a5a9b7' }} data-testid="status-loading">
            <div className="skeleton" style={{ width: 185, height: 11, marginBottom: 11 }} />
            Подключаемся к помощнику…
          </div>}
          {statusQuery.isError && <div className="error-card" data-testid="status-error">
            Не удалось проверить подключение к ИИ. Разговоры остаются на этом устройстве.
            <br /><button onClick={() => void statusQuery.refetch()} data-testid="button-retry-status"><RotateCw size={13} /> Проверить снова</button>
          </div>}
          {!statusQuery.isLoading && status && !status.configured && <div className="error-card" data-testid="status-not-configured">
            ИИ пока не подключён. Настройте провайдера, чтобы получать ответы; ваши разговоры сохраняются только в этом браузере.
          </div>}

          {authError && <div className="error-card" role="status">{authError}</div>}
          {authReady && !user && messages.length === 0 && <div className="local-note" data-testid="status-local-only">Сейчас разговоры хранятся только на этом устройстве. Войдите через Google, чтобы они были доступны везде.</div>}
          {messages.length === 0 ? (
            <section className="welcome" aria-labelledby="welcome-heading">
              <div className="eyebrow"><Sparkles size={12} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 6 }} />Ваше пространство для идей</div>
              <h1 id="welcome-heading">С чего начнём?</h1>
              <p>Задайте вопрос, продумайте идею или попросите помочь с задачей. Я здесь, чтобы разложить сложное по полочкам.</p>
              <div className="voice-actions">
                <button type="button" className={`voice-action primary ${listening ? 'active' : ''}`} onClick={toggleListening} aria-pressed={listening} data-testid="button-welcome-voice">
                  <span className="voice-action-icon">{listening ? <MicOff size={22} /> : <Mic size={22} />}</span>
                  <span><strong>{listening ? 'Слушаю… нажмите, чтобы закончить' : 'Спросить голосом'}</strong><small>Говорите — я запишу вопрос</small></span>
                </button>
                <button type="button" className={`voice-action ${preferences.autoSpeak ? 'active' : ''}`} onClick={() => updatePreference({ autoSpeak: !preferences.autoSpeak })} aria-pressed={preferences.autoSpeak} data-testid="button-welcome-autospeak">
                  <span className="voice-action-icon"><Volume2 size={22} /></span>
                  <span><strong>{preferences.autoSpeak ? 'Ответы звучат вслух' : 'Слушать ответы'}</strong><small>{preferences.autoSpeak ? 'Нажмите, чтобы выключить' : 'Dima будет читать ответы'}</small></span>
                </button>
              </div>
            </section>
          ) : (
            <section className="conversation" ref={transcriptRef} aria-label="История разговора" data-testid="conversation-history">
              {messages.map((entry) => (
                <article key={entry.id} className={`message ${entry.role}`} data-testid={`message-${entry.role}-${entry.id}`}>
                  <div className="avatar" aria-hidden="true">{entry.role === 'user' ? <span style={{ fontSize: 11, fontWeight: 700 }}>Вы</span> : entry.role === 'notice' ? <CircleHelp size={16} /> : entry.role === 'error' ? <CircleHelp size={16} /> : <Bot size={17} />}</div>
                  <div className="message-body">
                    <div className="message-meta">{entry.role === 'user' ? 'Вы' : entry.role === 'notice' ? 'Возможности браузера' : entry.role === 'error' ? 'Не удалось выполнить' : 'Dima'} · {formatTime(entry.time)}</div>
                    <div className="bubble" data-testid={`text-message-content-${entry.id}`}>{entry.content}</div>
                    {entry.role === 'assistant' && <button className="message-speak" onClick={() => speak(entry.content)} data-testid={`button-speak-message-${entry.id}`} aria-label="Озвучить этот ответ">
                      <Volume2 size={13} /> Озвучить ответ
                    </button>}
                  </div>
                </article>
              ))}
              {sendMessage.isPending && <div className="message" data-testid="status-thinking"><div className="avatar"><Bot size={17} /></div><div className="message-body"><div className="message-meta">Dima думает</div><div className="thinking" aria-label="Формируем ответ"><i /><i /><i /></div></div></div>}
              {requestError && <div className="error-card" data-testid="status-send-error">{requestError}
                {status?.configured && <><br /><button onClick={() => {
                  const lastUser = [...messages].reverse().find((entry) => entry.role === 'user' && !entry.localOnly);
                  if (lastUser) {
                    setRequestError('');
                    const retryHistory = messages
                      .filter((entry) => !entry.localOnly && (entry.role === 'user' || entry.role === 'assistant'))
                      .map(({ role, content: itemContent }) => ({ role: role as 'user' | 'assistant', content: itemContent }));
                    void sendMessage.mutateAsync({ data: { messages: retryHistory.slice(-40) } }).then((response) => {
                      const answer = response?.message?.content;
                      if (!answer?.trim()) { setRequestError('Сервис не вернул ответ. Попробуйте отправить сообщение ещё раз.'); return; }
                      updateMessages(currentThreadId, (current) => [...current, makeEntry('assistant', answer)]);
                      if (preferences.autoSpeak) speak(answer);
                    }).catch(() => setRequestError('Не удалось получить ответ от ИИ. Проверьте подключение и повторите попытку.'));
                  }
                }} data-testid="button-retry-message"><RotateCw size={13} /> Повторить отправку</button></>}
              </div>}
            </section>
          )}

          {messages.length === 0 && <div className="suggestions" aria-label="Идеи для начала">
            {suggestions.map((suggestion, index) => <button className="suggestion" key={suggestion.title} onClick={() => void submitMessage(suggestion.prompt)} data-testid={`button-suggestion-${index + 1}`}>
              <strong>{suggestion.title}</strong><span>{suggestion.detail}</span>
            </button>)}
          </div>}

          <div className="composer-wrap">
            {speechError && <div className="local-note" role="status" data-testid="status-speech-error">{speechError}</div>}
            {speaking && <div className="local-note" data-testid="status-speaking">Dima говорит · <button className="voice-stop" onClick={stopSpeaking} data-testid="button-stop-speaking"><Square size={11} fill="currentColor" style={{ verticalAlign: '-1px' }} /> Остановить</button></div>}
            <form className="composer" onSubmit={(event) => { event.preventDefault(); void submitMessage(); }}>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitMessage(); } }}
                placeholder="Напишите сообщение…"
                aria-label="Сообщение помощнику"
                data-testid="input-message"
                rows={2}
              />
              <div className="composer-actions">
                <span className="composer-hint">{listening ? 'Слушаю вас…' : 'Ввод — отправить · Shift + Ввод — новая строка'}</span>
                <div className="action-cluster">
                  <button type="button" className={`mic-button ${listening ? 'listening' : ''}`} onClick={toggleListening} aria-label={listening ? 'Остановить запись' : 'Надиктовать сообщение'} aria-pressed={listening} data-testid="button-microphone">
                    {listening ? <MicOff size={18} /> : <Mic size={18} />}
                  </button>
                  <button type="submit" className="send-button" disabled={!draft.trim() || sendMessage.isPending} data-testid="button-send-message" aria-label="Отправить сообщение">
                    {sendMessage.isPending ? <span className="thinking" style={{ padding: 0 }}><i /><i /><i /></span> : <><Send size={16} /><span className="send-label">Отправить</span></>}
                  </button>
                </div>
              </div>
            </form>
            <div className="composer-foot">Ответы ИИ могут быть неточными. Важное всегда проверяйте.</div>
          </div>
        </main>

        <footer className="footer">
          <div className="footer-note"><Activity size={12} /> <span>Личная история хранится на этом устройстве</span></div>
          <div className="footer-note"><Volume2 size={12} /> <span>Голосовой ввод и озвучивание — функции браузера</span></div>
        </footer>
      </div>

      {settingsOpen && <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
        <section className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-heading" data-testid="dialog-settings">
          <div className="sheet-head">
            <div><h2 id="settings-heading">Настройки</h2><p>Голос и подключение помощника</p></div>
            <button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Закрыть настройки" data-testid="button-close-settings"><X size={17} /></button>
          </div>
          <div className="settings-row">
            <div><div className="setting-title">Автоматически озвучивать ответы</div><div className="setting-description">Новый ответ будет прочитан вслух голосом браузера.</div></div>
            <button className="switch" role="switch" aria-checked={preferences.autoSpeak} onClick={() => updatePreference({ autoSpeak: !preferences.autoSpeak })} aria-label="Автоматически озвучивать ответы" data-testid="switch-auto-speak" />
          </div>
          <div className="settings-row">
            <div><div className="setting-title">Скорость речи</div><div className="setting-description" data-testid="text-voice-name">Выбранный голос: ElevenLabs Adam</div></div>
            <div className="rate-control">
              <input type="range" min=".7" max="1.5" step=".1" value={preferences.voiceRate} onChange={(event) => updatePreference({ voiceRate: Number(event.target.value) })} aria-label="Скорость речи" data-testid="input-voice-rate" />
              <span className="rate-value" data-testid="text-voice-rate">{preferences.voiceRate.toFixed(1)}×</span>
            </div>
          </div>
          {!voiceAvailable && <div className="local-note" style={{ textAlign: 'left' }} data-testid="status-voice-unsupported">Озвучивание не поддерживается этим браузером.</div>}
          
          <div className="status-card" data-testid="card-ai-status">
            <div className="status-card-top"><span className={`status-dot ${statusQuery.isLoading ? 'waiting' : status?.configured ? 'ready' : ''}`} />
              <span>{statusQuery.isLoading ? 'Проверяем подключение' : statusQuery.isError ? 'Сервер недоступен' : status?.configured ? 'ИИ готов к работе' : 'ИИ не настроен'}</span>
              {statusQuery.isLoading && <div className="skeleton" style={{ width: 60, height: 9 }} />}
            </div>
            {status?.configured && <p>{[status.provider, status.model].filter(Boolean).join(' · ') || status.message}</p>}
            {!status?.configured && <p>{status?.message || (statusQuery.isError ? 'Не удалось получить состояние сервера. Попробуйте проверить подключение ещё раз.' : 'Чтобы получать ответы, администратору нужно настроить провайдера ИИ.')}</p>}
            {statusQuery.isError && <button className="voice-stop" style={{ marginTop: 9 }} onClick={() => void statusQuery.refetch()} data-testid="button-settings-retry-status"><RotateCw size={12} style={{ verticalAlign: '-2px' }} /> Проверить снова</button>}
          </div>
          <div className="status-card setup-card" data-testid="card-secure-provider-setup">
            <div className="status-card-top"><Settings2 size={15} /><span>Безопасное подключение</span></div>
            <p>Ответы формирует Lovable AI на сервере. Ключ доступа хранится только на сервере и никогда не передаётся в браузер.</p>
          </div>
          <div className="dialog-actions"><button className="soft-button" onClick={() => setSettingsOpen(false)} data-testid="button-done-settings"><Check size={15} /> Готово</button></div>
        </section>
      </div>}

      {historyOpen && <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryOpen(false); }}>
        <section className="settings-sheet history-sheet" role="dialog" aria-modal="true" aria-labelledby="history-heading" data-testid="dialog-conversation-history">
          <div className="sheet-head">
            <div><h2 id="history-heading">История разговоров</h2><p>{conversationState.threads.length} сохранено на этом устройстве</p></div>
            <button className="icon-button" onClick={() => setHistoryOpen(false)} aria-label="Закрыть историю" data-testid="button-close-history"><X size={17} /></button>
          </div>
          <div className="history-list">
            {[...conversationState.threads].sort((a, b) => b.updatedAt - a.updatedAt).map((thread) => (
              <button className={`history-item ${thread.id === currentThreadId ? 'selected' : ''}`} key={thread.id} onClick={() => openConversation(thread.id)} data-testid={`button-open-conversation-${thread.id}`}>
                <span className="history-icon"><Clock3 size={16} /></span>
                <span className="history-copy">
                  <strong>{thread.title}</strong>
                  <span>{thread.messages.length ? `${thread.messages.length} сообщ. · ${formatTime(thread.updatedAt)}` : `Пустой разговор · ${formatTime(thread.updatedAt)}`}</span>
                </span>
                {thread.id === currentThreadId && <span className="history-current">Открыт</span>}
              </button>
            ))}
            {!conversationState.threads.length && <div className="history-empty">Сохранённых разговоров пока нет.</div>}
          </div>
          <div className="dialog-actions"><button className="soft-button" onClick={newConversation} data-testid="button-new-conversation-from-history"><Plus size={15} /> Новый разговор</button></div>
        </section>
      </div>}
    </div>
  );
}

