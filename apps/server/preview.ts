import { z } from 'zod';
export const previewActions = z
  .array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('click'), selector: z.string().min(1).max(300) }),
      z.object({
        type: z.literal('expect-text'),
        selector: z.string().min(1).max(300),
        text: z.string().max(2000),
      }),
    ]),
  )
  .max(8)
  .default([]);
export type PreviewAction = z.infer<typeof previewActions>[number];
export interface PreviewResult {
  title: string;
  text: string;
  errors: string[];
  screenshot?: string;
  checks?: { action: PreviewAction; passed: boolean; observed?: string; error?: string }[];
}
export interface PreviewDriver {
  render(content: string, actions?: PreviewAction[]): Promise<PreviewResult>;
}
