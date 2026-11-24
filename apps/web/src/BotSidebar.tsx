import { Archive, Crown, LoaderCircle } from 'lucide-react';
import { openBotArchive, openBotMenu } from './BotActions';
import { useEffect, useRef, useState } from 'react';
import { visibleBots, type BotCategory } from '../../../packages/shared/team';
import type { BotWork } from '../../../packages/shared/activity';
import { workLabel } from '../../../packages/shared/activity';
import type { Bot, Run } from '../../../packages/shared/types';
import { Avatar } from './Avatar';
import { mainBot } from '../../../packages/shared/main-bot';

export function BotRoster({
  bots,
  runs,
  work,
  now,
  selectedBotId,
  openBot,
  categories = [],
  mainBotId,
  moveBot,
}: {
  bots: Bot[];
  runs: Run[];
  work: Map<string, BotWork>;
  now: number;
  selectedBotId?: string;
  openBot: (id: string) => void;
  categories?: BotCategory[];
  mainBotId?: string | null;
  moveBot?: (botId: string, categoryId: string | null) => Promise<void>;
}) {
  const [dragging, setDragging] = useState<string>();
  const [dropCategory, setDropCategory] = useState<string>();
  const groupsElement = useRef<HTMLDivElement>(null);
  const dragImage = useRef<HTMLElement | null>(null);
  const scrollFrame = useRef(0);
  const scrollSpeed = useRef(0);
  const draggedId = useRef<string | undefined>(undefined);
  const suppressClickUntil = useRef(0);
  function stopDrag() {
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = 0;
    scrollSpeed.current = 0;
    draggedId.current = undefined;
    dragImage.current?.remove();
    dragImage.current = null;
    setDragging(undefined);
    setDropCategory(undefined);
  }
  useEffect(
    () => () => {
      cancelAnimationFrame(scrollFrame.current);
      dragImage.current?.remove();
    },
    [],
  );
  function scrollDrag(clientY: number) {
    const element = groupsElement.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    const edge = 44;
    scrollSpeed.current =
      clientY < bounds.top + edge
        ? -Math.min(8, (bounds.top + edge - clientY) / 5)
        : clientY > bounds.bottom - edge
          ? Math.min(8, (clientY - bounds.bottom + edge) / 5)
          : 0;
    if (!scrollFrame.current && scrollSpeed.current) {
      const tick = () => {
        if (!draggedId.current || !scrollSpeed.current) {
          scrollFrame.current = 0;
          return;
        }
        element.scrollTop += scrollSpeed.current;
        scrollFrame.current = requestAnimationFrame(tick);
      };
      scrollFrame.current = requestAnimationFrame(tick);
    }
  }
  const showing = visibleBots(bots),
    featured = mainBot(showing, mainBotId),
    parents = showing.filter((b) => !b.prototypeId && b.id !== featured?.id);
  const groups = [
    ...categories,
    { id: '', name: categories.length ? 'Other' : '', color: '#91b472' },
  ];
  const ordered = groups.flatMap((c) =>
    parents
      .filter((b) =>
        c.id ? b.categoryId === c.id : !categories.some((category) => category.id === b.categoryId),
      )
      .flatMap((b) => [b, ...showing.filter((clone) => clone.prototypeId === b.id)]),
  );
  const otherBusy = work.size - (featured && work.has(featured.id) ? 1 : 0);
  function renderBot(bot: Bot, isMain = false) {
    const active = work.get(bot.id);
    const recent = runs.find((run) => run.botId === bot.id);
    const failed = !active && recent?.status === 'failed';
    const label = active
      ? workLabel(active, bot.id, now, bot)
      : !bot.enabled
        ? 'Taking a breather'
        : bot.isPrototype
          ? `${showing.filter((b) => b.prototypeId === bot.id).length || 'No'} active workers`
          : failed
            ? 'Needs a little help'
            : 'Ready to help';
    return (
      <button
        key={bot.id}
        type="button"
        className={`bot-roster-row ${dragging === bot.id ? 'is-dragging' : ''} ${isMain ? 'main-bot-row' : ''} ${bot.prototypeId ? 'is-clone' : ''} ${active ? 'working' : ''} ${active?.phase === 'waiting' ? 'waiting' : ''} ${selectedBotId === bot.id ? 'selected' : ''} ${!bot.enabled ? 'paused' : ''}`}
        aria-label={`Open ${bot.name}`}
        aria-current={selectedBotId === bot.id ? 'page' : undefined}
        aria-describedby={`bot-status-${bot.id}`}
        title={`${bot.name}${isMain ? ' · Main bot' : ''} · ${label}${active?.detail ? `\n${active.detail}` : ''}`}
        data-bot-id={bot.id}
        data-work-phase={active?.phase ?? 'idle'}
        draggable={!!moveBot && !isMain && !bot.prototypeId}
        onDragStart={(event) => {
          if (!moveBot || isMain || bot.prototypeId) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.setData('application/x-bot-bots-bot', bot.id);
          event.dataTransfer.effectAllowed = 'move';
          // Use a small, static image instead of Chromium snapshotting the animated row.
          const image = document.createElement('div');
          image.className = 'bot-roster-drag-image';
          image.textContent = bot.name;
          document.body.append(image);
          dragImage.current = image;
          event.dataTransfer.setDragImage(image, 18, 18);
          draggedId.current = bot.id;
          suppressClickUntil.current = Date.now() + 500;
          setDragging(bot.id);
        }}
        onDragEnd={() => {
          suppressClickUntil.current = Date.now() + 250;
          stopDrag();
        }}
        onClick={() => {
          if (!draggedId.current && Date.now() >= suppressClickUntil.current) openBot(bot.id);
        }}
        onContextMenu={(event) => moveBot && !bot.prototypeId && openBotMenu(bot.id, event)}
      >
        <span className="roster-avatar">
          <Avatar avatar={bot.avatar} size={isMain ? 48 : 36} busy={!!active} />
          {isMain && (
            <span className="roster-main-mark" title="Main bot" aria-label="Main bot">
              <Crown size={11} />
            </span>
          )}
          {active ? (
            <span className="roster-working-indicator">
              <LoaderCircle
                size={12}
                className="bot-working-spinner"
                role="img"
                aria-label={`${bot.name} is working`}
              />
            </span>
          ) : (
            <span
              className={`roster-idle-dot ${failed ? 'needs-help' : !bot.enabled ? 'paused' : ''}`}
            />
          )}
        </span>
        <span className="bot-roster-copy">
          <strong>{bot.name}</strong>
          <small id={`bot-status-${bot.id}`} className="bot-work-label">
            {label}
          </small>
        </span>
      </button>
    );
  }
  return (
    <section
      className={`bot-roster-section ${dragging ? 'is-dragging-bot' : ''}`}
      aria-label="Your bot team"
    >
      <nav className="bot-roster" aria-label="Your bots">
        {featured && (
          <div className="roster-main-section" role="group" aria-label="Main bot">
            <div className="roster-main-heading">Main bot</div>
            {renderBot(featured, true)}
          </div>
        )}
        <div className="roster-heading">
          <span>
            {featured ? 'Other bots' : 'Your bots'}{' '}
            <span className="roster-count">{ordered.length}</span>
          </span>
          {otherBusy > 0 && <span className="roster-busy-count">{otherBusy} busy</span>}
        </div>
        <div
          className="bot-roster-groups"
          ref={groupsElement}
          onDragOver={(event) => {
            if (draggedId.current) scrollDrag(event.clientY);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              scrollSpeed.current = 0;
              setDropCategory(undefined);
            }
          }}
        >
          {groups.map((category) => {
            const members = ordered.filter((bot) => {
              const assigned = bot.prototypeId
                ? bots.find((parent) => parent.id === bot.prototypeId)?.categoryId
                : bot.categoryId;
              return category.id
                ? assigned === category.id
                : !categories.some((known) => known.id === assigned);
            });
            return (
              <section
                key={category.id || 'other'}
                className={`roster-category-group ${dragging ? 'accepts-bot' : ''} ${dropCategory === category.id ? 'is-drop-target' : ''}`}
                data-category-id={category.id}
                onDragOver={(event) => {
                  if (moveBot && draggedId.current) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDropCategory(category.id);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const id = event.dataTransfer.getData('application/x-bot-bots-bot');
                  const allowed = id === draggedId.current;
                  stopDrag();
                  const bot = parents.find((candidate) => candidate.id === id);
                  if (allowed && bot && moveBot && (bot.categoryId ?? '') !== category.id)
                    void moveBot(id, category.id || null);
                }}
              >
                {categories.length > 0 && (
                  <div className="roster-category">
                    {category.name}
                    {!members.length && <small> · Drop a bot here</small>}
                  </div>
                )}
                {members.map((bot) => renderBot(bot))}
              </section>
            );
          })}
        </div>
      </nav>
      <button className="archive-toggle" onClick={openBotArchive}>
        <Archive size={15} />
        Archived bots{' '}
        <span>
          {bots.filter((bot) => bot.archivedAt && !bot.deletedAt && !bot.prototypeId).length}
        </span>
      </button>
    </section>
  );
}
