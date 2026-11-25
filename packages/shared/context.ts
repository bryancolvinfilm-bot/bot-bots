export interface ContextCheckpoint {
  id: string;
  botId: string;
  conversationId: string;
  runId: string;
  workId: string;
  createdAt: string;
  summary: string;
  ledger: string;
  archive: string;
  characters: number;
  throughMessageId?: string;
}
