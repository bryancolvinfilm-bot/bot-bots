import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import type { DictationTarget, SpeechCapabilities } from '../../../packages/shared/speech';
import { DictationCapture, type DictationState } from './dictation';
import './speech.css';
export interface VoiceInputHandle {
  cancel(): void;
}
export const VoiceInput = forwardRef<
  VoiceInputHandle,
  { disabled: boolean; target: () => DictationTarget | undefined }
>(function VoiceInput({ disabled, target }, ref) {
  const [state, setState] = useState<DictationState>('idle'),
    [error, setError] = useState('');
  const [capabilities, setCapabilities] = useState<SpeechCapabilities>();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState(
    () => localStorage.getItem('bot-bots-microphone') ?? 'default',
  );
  const capture = useRef<DictationCapture | undefined>(undefined),
    mounted = useRef(true);
  const active = state !== 'idle';
  useImperativeHandle(ref, () => ({ cancel: () => capture.current?.cancel(true) }), []);
  async function refreshDevices() {
    try {
      setDevices(
        ((await navigator.mediaDevices?.enumerateDevices()) ?? []).filter(
          (item) =>
            item.kind === 'audioinput' &&
            item.deviceId &&
            !['default', 'communications'].includes(item.deviceId),
        ),
      );
    } catch {
      /* Starting the mic gives a specific permission/device error. */
    }
  }
  useEffect(() => {
    mounted.current = true;
    void window.botBotsSpeech?.capabilities(navigator.language).then(
      (value) => {
        if (mounted.current) setCapabilities(value);
      },
      () => {
        if (mounted.current)
          setCapabilities({
            available: false,
            engine: 'System speech',
            local: true,
            error: 'System speech is unavailable.',
          });
      },
    );
    void refreshDevices();
    const changed = () => void refreshDevices();
    const blur = () => {
      if (document.visibilityState === 'hidden') capture.current?.cancel(true);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void capture.current?.stop();
    };
    navigator.mediaDevices?.addEventListener('devicechange', changed);
    document.addEventListener('visibilitychange', blur);
    window.addEventListener('keydown', escape);
    return () => {
      mounted.current = false;
      capture.current?.cancel(false);
      navigator.mediaDevices?.removeEventListener('devicechange', changed);
      document.removeEventListener('visibilitychange', blur);
      window.removeEventListener('keydown', escape);
    };
  }, []);
  useEffect(() => {
    if (disabled) capture.current?.cancel(true);
  }, [disabled]);
  async function toggle() {
    if (active) {
      await capture.current?.stop();
      return;
    }
    if (!window.botBotsSpeech || !capabilities?.available) return;
    const insertion = target();
    if (!insertion) return;
    setError('');
    const session = new DictationCapture(window.botBotsSpeech, insertion, (next, message) => {
      if (!mounted.current) return;
      setState(next);
      if (message) setError(message);
      if (next === 'listening' || next === 'idle') void refreshDevices();
    });
    capture.current = session;
    await session.start(device, capabilities.locale ?? navigator.language);
  }
  const unavailable = !window.botBotsSpeech
    ? 'Voice input uses the Windows or macOS desktop app.'
    : capabilities?.error;
  return (
    <div className="voice-input" aria-label="Voice input">
      <button
        type="button"
        className={`icon-button voice-mic ${active ? 'listening' : ''}`}
        aria-label={active ? 'Stop dictation' : 'Start dictation'}
        aria-pressed={active}
        title={active ? 'Stop dictation (Esc)' : (unavailable ?? 'Speak your prompt')}
        disabled={disabled || (!active && !capabilities?.available)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void toggle()}
      >
        {active ? <Square size={15} /> : <Mic size={18} />}
      </button>
      <select
        aria-label="Microphone input"
        title="Microphone on this computer"
        value={device}
        disabled={active || disabled || !window.botBotsSpeech}
        onChange={(event) => {
          setDevice(event.target.value);
          localStorage.setItem('bot-bots-microphone', event.target.value);
        }}
      >
        <option value="default">Default microphone</option>
        {device !== 'default' && !devices.some((item) => item.deviceId === device) && (
          <option value={device} disabled>
            Saved microphone · allow access to check
          </option>
        )}
        {devices.map((item, index) => (
          <option key={item.deviceId} value={item.deviceId}>
            {item.label || `Microphone ${index + 1}`}
          </option>
        ))}
      </select>
      <small className="voice-status" role="status">
        {state === 'starting'
          ? 'Starting system speech…'
          : state === 'listening'
            ? 'Listening · speak your prompt'
            : state === 'stopping'
              ? 'Finishing dictation…'
              : capabilities?.available
                ? `${capabilities.engine}${capabilities.local ? ' · on this computer' : ' · may use Apple speech services'}`
                : (unavailable ?? 'Checking system speech…')}
      </small>
      {error && (
        <small className="error-text" role="alert">
          {error}
        </small>
      )}
    </div>
  );
});
