export interface SpeechCapabilities {
  available: boolean;
  engine: string;
  locale?: string;
  local: boolean;
  error?: string;
}
export interface SpeechEvent {
  id: string;
  type: 'ready' | 'transcript' | 'error' | 'ended';
  text?: string;
  final?: boolean;
  message?: string;
}
export interface DictationTarget {
  update(text: string): boolean;
  finish(notify?: boolean): void;
}
export function joinDictation(committed: string, partial: string) {
  return [committed.trim(), partial.trim()].filter(Boolean).join(' ');
}
declare global {
  interface Window {
    botBotsSpeech?: {
      capabilities(locale: string): Promise<SpeechCapabilities>;
      start(id: string, locale: string): Promise<void>;
      audio(id: string, pcm: ArrayBuffer): void;
      stop(id: string, cancel?: boolean): Promise<void>;
      onEvent(listener: (event: SpeechEvent) => void): () => void;
    };
  }
}
