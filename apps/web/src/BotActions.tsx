import { Archive, ArchiveRestore, FolderInput, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Bootstrap, Bot } from '../../../packages/shared/types';
import { api } from './api';
import { Avatar } from './Avatar';
import { Modal } from './ui';
import './bot-actions.css';

export function openBotMenu(
  botId: string,
  event: { preventDefault(): void; clientX: number; clientY: number },
) {
  event.preventDefault();
  window.dispatchEvent(
    new CustomEvent('bot-bots:bot-menu', { detail: { botId, x: event.clientX, y: event.clientY } }),
  );
}
export function openBotArchive() {
  window.dispatchEvent(new CustomEvent('bot-bots:bot-archive'));
}
export function BotActions({
  data,
  refresh,
  notify,
}: {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [menu, setMenu] = useState<{ botId: string; x: number; y: number }>(),
    [archive, setArchive] = useState(false),
    [deleting, setDeleting] = useState<Bot>(),
    [moving, setMoving] = useState<Bot>(),
    [moveCategory, setMoveCategory] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const owner = !data.accessRole || data.accessRole === 'owner';
  useEffect(() => {
    const context = (event: Event) => {
      if (owner) setMenu((event as CustomEvent).detail);
    };
    const archived = () => {
      setArchive(true);
      setError('');
      setMenu(undefined);
    };
    const dismiss = () => setMenu(undefined);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    window.addEventListener('bot-bots:bot-menu', context);
    window.addEventListener('bot-bots:bot-archive', archived);
    window.addEventListener('click', dismiss);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('bot-bots:bot-menu', context);
      window.removeEventListener('bot-bots:bot-archive', archived);
      window.removeEventListener('click', dismiss);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', dismiss);
    };
  }, [owner]);
  const selected = data.bots.find(
    (bot) => bot.id === menu?.botId && !bot.deletedAt && !bot.prototypeId,
  );
  const archived = data.bots.filter((bot) => bot.archivedAt && !bot.deletedAt && !bot.prototypeId);
  async function change(bot: Bot, action: 'archive' | 'restore' | 'delete') {
    setMenu(undefined);
    setBusy(true);
    setError('');
    try {
      await api(
        `/bots/${bot.id}${action === 'delete' ? '' : `/${action}`}`,
        action === 'delete' ? 'DELETE' : 'POST',
        {},
      );
      await refresh();
      setDeleting(undefined);
      notify(
        action === 'archive'
          ? `${bot.name} is safely archived`
          : action === 'restore'
            ? `${bot.name} is back in your team`
            : `${bot.name} and its current instructions were deleted`,
      );
    } catch (error) {
      setError((error as Error).message);
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function move() {
    if (!moving) return;
    setBusy(true);
    setError('');
    try {
      await api(`/bots/${moving.id}/category`, 'PATCH', { categoryId: moveCategory || null });
      await refresh();
      setMoving(undefined);
      notify(
        `${moving.name} moved to ${data.categories?.find((category) => category.id === moveCategory)?.name ?? 'Other'}`,
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {selected && owner && (
        <div
          role="menu"
          aria-label={`Manage ${selected.name}`}
          className="bot-context-menu"
          style={{
            left: Math.max(8, Math.min(menu!.x, window.innerWidth - 235)),
            top: Math.max(8, Math.min(menu!.y, window.innerHeight - 210)),
          }}
        >
          <strong>{selected.name}</strong>
          {!selected.archivedAt && selected.id !== data.settings.mainBotId && (
            <button
              role="menuitem"
              onClick={() => {
                setMoving(selected);
                setMoveCategory(selected.categoryId ?? '');
                setMenu(undefined);
                setError('');
              }}
            >
              <FolderInput size={16} />
              Move to group…
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => void change(selected, selected.archivedAt ? 'restore' : 'archive')}
          >
            <Archive size={16} />
            {selected.archivedAt ? 'Unarchive bot' : 'Archive bot'}
          </button>
          <button
            role="menuitem"
            className="danger-text"
            onClick={() => {
              setDeleting(selected);
              setMenu(undefined);
              setError('');
            }}
          >
            <Trash2 size={16} />
            Delete bot…
          </button>
        </div>
      )}
      {moving && (
        <Modal title={`Move ${moving.name}`} close={() => !busy && setMoving(undefined)}>
          <label className="field">
            <span>Group</span>
            <select
              aria-label="Move bot to group"
              value={moveCategory}
              onChange={(event) => setMoveCategory(event.target.value)}
              disabled={busy}
            >
              {data.categories?.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
              <option value="">Other</option>
            </select>
          </label>
          {error && <p role="alert">{error}</p>}
          <div className="modal-footer">
            <button className="secondary" disabled={busy} onClick={() => setMoving(undefined)}>
              Cancel
            </button>
            <button className="primary" disabled={busy} onClick={() => void move()}>
              Move bot
            </button>
          </div>
        </Modal>
      )}
      {deleting ? (
        <Modal title={`Delete ${deleting.name}?`} close={() => !busy && setDeleting(undefined)}>
          <p>
            <strong>Are you sure you want to delete this bot and its instructions?</strong>
          </p>
          <p>
            Consider archiving it instead. Archiving keeps its instructions and lets you bring it
            back later.
          </p>
          <p className="muted">
            Delete removes its current profile instructions, bot memory and routines. Saved chats,
            task results and earlier backups remain. A small name/avatar record preserves
            attribution. Deleting does not revoke service credentials.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="modal-footer">
            <button className="secondary" disabled={busy} onClick={() => setDeleting(undefined)}>
              Cancel
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                deleting.archivedAt ? setDeleting(undefined) : void change(deleting, 'archive')
              }
            >
              <Archive size={15} />
              Archive instead
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => void change(deleting, 'delete')}
            >
              <Trash2 size={15} />
              Delete bot
            </button>
          </div>
        </Modal>
      ) : (
        archive && (
          <Modal title="Archived bots" close={() => !busy && setArchive(false)} wide>
            <p>
              A quiet place for bots you want to keep. Unarchive a bot to return it to its previous
              category. Its routines stay paused until you enable them.
            </p>
            {error && <p role="alert">{error}</p>}
            {!archived.length && (
              <div className="archive-empty">
                <Archive size={38} />
                <p>No archived bots. Right-click a bot to archive it.</p>
              </div>
            )}
            <div className="archived-bot-list">
              {archived.map((bot) => (
                <article key={bot.id} data-archived-bot={bot.id}>
                  <Avatar avatar={bot.avatar} size={44} />
                  <div>
                    <strong>{bot.name}</strong>
                    <small>
                      {data.categories?.find((category) => category.id === bot.categoryId)?.name ??
                        'Other'}{' '}
                      · Instructions kept safely
                    </small>
                  </div>
                  {owner && (
                    <>
                      <button
                        className="secondary small"
                        disabled={busy}
                        onClick={() => void change(bot, 'restore')}
                      >
                        <ArchiveRestore size={15} />
                        Unarchive
                      </button>
                      <button
                        className="icon-button danger-text"
                        aria-label={`Delete ${bot.name}`}
                        disabled={busy}
                        onClick={() => {
                          setDeleting(bot);
                          setError('');
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  )}
                </article>
              ))}
            </div>
          </Modal>
        )
      )}
    </>
  );
}
