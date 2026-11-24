import {
  ArrowRight,
  Crown,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { useState } from 'react';
import { workLabel, type BotWork } from '../../../packages/shared/activity';
import type { Bootstrap, Bot } from '../../../packages/shared/types';
import { Avatar, emptyAvatar } from './Avatar';
import { visibleBots } from '../../../packages/shared/team';
import { canBeMainBot, mainBot } from '../../../packages/shared/main-bot';
import { api } from './api';
import { openBotMenu } from './BotActions';

import { Heading } from './ui';
export function Team({
  data,
  chat,
  edit,
  work,
  workClock,
  act,
}: {
  data: Bootstrap;
  chat: (id: string) => void;
  edit: (b: Bot | null) => void;
  work: Map<string, BotWork>;
  workClock: number;
  act: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [category, setCategory] = useState('');
  const bots = visibleBots(data.bots).filter(
    (b) =>
      (!category || b.categoryId === category) &&
      (filter !== 'specialists' || !b.name.startsWith('Worker')) &&
      (filter !== 'helpers' || b.name.startsWith('Worker')) &&
      `${b.name} ${b.title} ${b.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  const [choosingMain, setChoosingMain] = useState(false);
  const chosenMain = mainBot(data.bots, data.settings.mainBotId);
  const owner = !data.accessRole || data.accessRole === 'owner';
  const heroAvatar =
    chosenMain?.avatar ?? data.bots.find((b) => b.id === 'boss-man')?.avatar ?? emptyAvatar;
  return (
    <main className="page team-page">
      <Heading
        eyebrow="A little team. A lot of possibility."
        title="Good things happen together."
        description="Your familiar bots, a little closer to home."
      >
        <button
          className="primary"
          disabled={!!data.accessRole && data.accessRole !== 'owner'}
          onClick={() => edit(null)}
        >
          <Plus size={16} />
          Create a bot
        </button>
      </Heading>
      <section className="welcome-card">
        <div className="welcome-copy">
          <div className="tiny-label">
            <span className="green-dot" />
            {chosenMain ? 'Your main bot' : 'Your little team'}
          </div>
          <h2>
            {chosenMain ? `Big plans? Start with ${chosenMain.name}.` : 'Who shall we start with?'}
          </h2>
          <p>
            {chosenMain
              ? 'A familiar face to bring the right teammates into bigger tasks.'
              : 'Choose a main bot for bigger plans, or chat with anyone below.'}
          </p>
          <div className="main-bot-choice">
            <label htmlFor="team-main-bot">Main bot (optional)</label>
            <select
              id="team-main-bot"
              aria-label="Main delegation bot"
              value={chosenMain?.id ?? ''}
              disabled={!owner || choosingMain}
              onChange={(e) => {
                const botId = e.target.value || null;
                setChoosingMain(true);
                void act(
                  () => api('/settings/main-bot', 'PUT', { botId }),
                  botId ? 'Main bot updated' : 'Main bot cleared',
                ).finally(() => setChoosingMain(false));
              }}
            >
              <option value="">No main bot</option>
              {data.bots.filter(canBeMainBot).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <small>
              Chat directly with your main bot to get its extra delegation help. Other chats stay
              with the bot you choose.
            </small>
          </div>
          {chosenMain && (
            <button
              className="dark-button"
              aria-label={`Talk to main bot ${chosenMain.name}`}
              onClick={() => chat(chosenMain.id)}
            >
              Let’s talk <ArrowRight size={16} />
            </button>
          )}
        </div>
        <div className="welcome-art">
          <span className="spark s1">✳</span>
          <span className="spark s2">✧</span>
          <span className="orbit o1" />
          <span className="orbit o2" />
          <div className="art-helper">
            <Avatar avatar={{ shape: 'teardrop', color: '#a1bbd8', accent: '#3d4852' }} size={96} />
          </div>
          <div className="art-boss">
            <Avatar avatar={heroAvatar} size={166} />
          </div>
          <div className="art-helper2">
            <Avatar avatar={{ shape: 'blob', color: '#b5c995', accent: '#3e4e36' }} size={110} />
          </div>
          <div className="art-note">
            <span className="green-dot" />
            Better as a team
          </div>
        </div>
      </section>
      <div className="team-toolbar">
        <div className="tabs">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            All bots <span>{visibleBots(data.bots).length}</span>
          </button>
          <button
            className={filter === 'specialists' ? 'active' : ''}
            onClick={() => setFilter('specialists')}
          >
            Specialists
          </button>
          <button
            className={filter === 'helpers' ? 'active' : ''}
            onClick={() => setFilter('helpers')}
          >
            Helping hands
          </button>
        </div>
        <label className="search">
          <Search size={16} />
          <input
            aria-label="Search bots"
            placeholder="Find a teammate…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <kbd>/</kbd>
        </label>
      </div>
      <div className="bot-grid">
        <div className="team-category-filter">
          <label>
            Category{' '}
            <select
              aria-label="Filter bot category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">All categories</option>
              {data.categories?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {bots.map((bot) => {
          const active = work.get(bot.id);
          const running = !!active;
          return (
            <article
              className={`bot-card ${bot.enabled ? '' : 'disabled'}`}
              key={bot.id}
              data-bot-id={bot.id}
              onContextMenu={(event) => owner && !bot.prototypeId && openBotMenu(bot.id, event)}
            >
              <div className="bot-card-top">
                <span className="bot-avatar-stage" style={{ background: `${bot.avatar.color}18` }}>
                  <Avatar avatar={bot.avatar} size={83} busy={running} />
                </span>
                <button
                  className="icon-button edit-bot"
                  aria-label={`Edit ${bot.name}`}
                  disabled={!!bot.prototypeId || (!!data.accessRole && data.accessRole !== 'owner')}
                  onClick={() => edit(bot)}
                >
                  <MoreHorizontal size={20} />
                </button>
              </div>
              <h3>
                {bot.name}
                {bot.isPrototype && <span className="coordinator-badge">PROTOTYPE</span>}
                {bot.id === chosenMain?.id && (
                  <span className="main-bot-badge">
                    <Crown size={12} /> Main bot
                  </span>
                )}
              </h3>
              <p>{bot.title}</p>
              <div className="bot-card-footer">
                <span className={`bot-status ${running ? 'working' : ''}`}>
                  <span className={bot.enabled ? 'green-dot' : 'gray-dot'} />
                  {active
                    ? workLabel(active, bot.id, workClock, bot)
                    : !bot.enabled
                      ? 'Paused'
                      : 'Ready to help'}
                </span>
                <button
                  className="chat-link"
                  aria-label={`Chat with ${bot.name}`}
                  onClick={() => chat(bot.id)}
                >
                  <MessageCircle size={16} />
                  <ArrowRight size={14} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {!bots.length && <div className="empty">No bots match that search.</div>}
      <footer className="page-footer">
        <span>
          <ShieldCheck size={14} />
          Local-first by design
        </span>
        <span>Made for your models. Built around you.</span>
      </footer>
    </main>
  );
}
