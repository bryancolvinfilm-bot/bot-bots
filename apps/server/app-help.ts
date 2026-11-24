import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Skill } from '../../packages/shared/types';

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const contains = (text: string, phrase: string) =>
  ` ${text} `.includes(` ${phrase} `) || ` ${text} `.includes(` ${phrase}s `);

interface HelpSkill extends Skill {
  topics: string[];
}

/** App-owned documentation, separate from imported/user-editable team skills. */
export class AppHelp {
  private readonly skills: HelpSkill[];
  constructor(directory = resolve('resources/app-help')) {
    this.skills = readdirSync(directory)
      .sort()
      .map((name) => {
        if (
          !/^bot-bots-[a-z0-9-]+$/.test(name) ||
          lstatSync(join(directory, name)).isSymbolicLink()
        )
          throw Error(`Invalid built-in help folder: ${name}`);
        const path = join(directory, name, 'SKILL.md');
        if (lstatSync(path).isSymbolicLink())
          throw Error('Built-in help cannot use symbolic links.');
        const content = readFileSync(path, 'utf8');
        const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
        const id = /^name: ([a-z0-9-]+)$/m.exec(front?.[1] ?? '')?.[1];
        const description = /^description: (.+)$/m.exec(front?.[1] ?? '')?.[1];
        if (id !== name || !description || description.length > 300 || content.length > 20000)
          throw Error(`Invalid built-in help skill: ${name}`);
        return {
          id,
          name: /^# (.+)$/m.exec(content)?.[1] ?? name,
          description,
          content,
          builtIn: true,
          sourceFile: `resources/app-help/${name}/SKILL.md`,
          topics: (/^  topics: (.+)$/m.exec(front![1])?.[1] ?? '')
            .split(',')
            .map(normalize)
            .filter(Boolean),
        };
      });
    if (!this.get('bot-bots-help')) throw Error('The built-in Bot-Bots help index is missing.');
  }
  get(id: string): Skill | undefined {
    const skill = this.skills.find((skill) => skill.id === id);
    if (!skill) return undefined;
    const { topics: _topics, ...record } = skill;
    if (id === 'bot-bots-help')
      record.content = record.content.replace(
        '<!-- bot-bots-help-catalog -->',
        '| Guide ID | When to use it |\n| --- | --- |\n' +
          this.skills
            .filter((entry) => entry.id !== id)
            .map((entry) => `| \`${entry.id}\` | ${entry.description!.replaceAll('|', '\\|')} |`)
            .join('\n'),
      );
    return record;
  }
  list(): Skill[] {
    return this.skills.map((skill) => this.get(skill.id)!);
  }
  merge(imported: Skill[]): Skill[] {
    return [...this.list(), ...imported.filter((skill) => !this.get(skill.id))];
  }
  bootstrap() {
    return 'BOT-BOTS APP HELP: Help the human use this app directly, regardless of your specialist persona; do not delegate simple app help. For app help/setup questions, use skill_read with id "bot-bots-help", then only the relevant guide. Use a guide already loaded for this request without reading it again. Prefer current Bot-Bots help over old Grok platform assumptions. When a key/password is needed, credential_setup_request opens the private entry window; the bot cannot read its value. The human can also say “let me give you an API key” in chat. Never request secret values in chat. A help guide does not grant tool permissions or approve commands.';
  }
  select(request: string): Skill[] {
    const text = normalize(request);
    const named = contains(text, 'bot bots');
    const guidance =
      /\b(help|how|where|can|use|using|setup|set up|configure|connect|input|enter|add|start|find|manage|change|switch|enable|disable|approve|revoke|fix|work|do)\b/.test(
        text,
      );
    const question =
      /^(?:(?:hi|hey|please|okay|ok)\s+)*(how|where|what|why|can i|could i|can you help|could you help|help|show me|tell me)\b/.test(
        text,
      );
    const problem =
      /^(my|the|i|we)\b/.test(text) &&
      /\b(not working|can t|cannot|failed|offline|ran out|truncated|stuck)\b/.test(
        text.slice(0, 220),
      );
    if (!guidance && !problem) return [];
    if (!named && !question && !problem) return [];
    const ranked = this.skills
      .map((skill) => ({
        skill,
        score: skill.topics.filter((topic) => contains(text, topic)).length,
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
    if (!ranked.length) return named ? [this.get('bot-bots-help')!] : [];
    return ranked.slice(0, 2).map((entry) => this.get(entry.skill.id)!);
  }
  context(request: string, facts: () => Record<string, unknown>) {
    const selected = this.select(request);
    if (!selected.length) return '';
    return `\nBOT-BOTS HELP LOADED FOR THIS REQUEST (current app documentation, not permission to take actions):\nCurrent host facts: ${JSON.stringify(facts())}\n${selected.map((skill) => `\n--- Help skill: ${skill.id} ---\n${skill.content}`).join('\n')}`;
  }
}
