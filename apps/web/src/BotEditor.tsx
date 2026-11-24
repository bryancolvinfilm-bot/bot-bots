import { useState } from 'react';
import type { Bootstrap, Bot } from '../../../packages/shared/types';
import { AVATAR_SHAPES } from '../../../packages/shared/types';
import { Avatar, emptyAvatar } from './Avatar';
import { api } from './api';
import type { BotCategory, ProcessingPhrases, PhraseContext } from '../../../packages/shared/team';

import { Field, Modal } from './ui';
import { BotModelPicker } from './BotModels';
export function BotEditor({
  bot,
  data,
  close,
  save,
}: {
  bot: Bot | null;
  data: Bootstrap;
  close: () => void;
  save: (b: Bot) => Promise<void>;
}) {
  const [b, setB] = useState<Bot>(
    bot ?? {
      id: '',
      name: '',
      title: 'Your new little teammate',
      description: '',
      instructions: 'Be helpful, honest, and concise.',
      avatar: emptyAvatar,
      modelId: null,
      enabled: true,
    },
  );
  const [tab, setTab] = useState('personality');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [phraseInputs, setPhraseInputs] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(bot?.processingPhrases ?? {}).map(([context, items]) => [
        context,
        items.join('\n'),
      ]),
    ),
  );
  const [categories, setCategories] = useState<BotCategory[]>(data.categories ?? []),
    [categoryName, setCategoryName] = useState(''),
    [suggesting, setSuggesting] = useState(false),
    [suggested, setSuggested] = useState<{
      phrases: ProcessingPhrases;
      basis: { pastTasks: number; futureRoutines: number };
    }>();
  return (
    <Modal title={bot ? `A little more ${bot.name}` : 'Meet your new teammate'} close={close} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void save(b).catch((e) => {
            setError(e.message);
            setBusy(false);
          });
        }}
      >
        <div className="bot-editor-top">
          <div style={{ background: `${b.avatar.color}1c` }}>
            <Avatar avatar={b.avatar} size={130} />
          </div>
          <section>
            <Field label="Name">
              <input
                required
                value={b.name}
                onChange={(e) => setB({ ...b, name: e.target.value })}
                maxLength={80}
              />
            </Field>
            <Field label="A little tagline">
              <input value={b.title} onChange={(e) => setB({ ...b, title: e.target.value })} />
            </Field>
          </section>
        </div>
        <div className="tabs editor-tabs">
          {['personality', 'appearance', 'instructions', 'activity'].map((t) => (
            <button
              type="button"
              className={tab === t ? 'active' : ''}
              key={t}
              onClick={() => setTab(t)}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        {tab === 'personality' && (
          <>
            <Field label="Bot category">
              <select
                value={b.categoryId ?? ''}
                onChange={(e) => setB({ ...b, categoryId: e.target.value || undefined })}
              >
                <option value="">Uncategorized</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="button-row">
              <input
                aria-label="New category name"
                placeholder="A new category…"
                value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
              />
              <button
                type="button"
                className="secondary small"
                disabled={!categoryName.trim()}
                onClick={() =>
                  void api<BotCategory>('/categories', 'POST', {
                    name: categoryName.trim(),
                    color: '#91b472',
                  }).then(
                    (c) => {
                      setCategories((old) => [...old, c]);
                      setCategoryName('');
                      setB({ ...b, categoryId: c.id });
                    },
                    (e) => setError(e.message),
                  )
                }
              >
                Add category
              </button>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={!!b.isPrototype}
                disabled={!!b.prototypeId}
                onChange={(e) => setB({ ...b, isPrototype: e.target.checked })}
              />
              Worker prototype
            </label>
            <p className="subtle">
              A prototype is a template. Coordinators can launch temporary clones for independent
              jobs; their results and learning remain in this prototype’s history after they retire.
            </p>
            <Field label="What does this bot do?">
              <textarea
                rows={6}
                value={b.description}
                onChange={(e) => setB({ ...b, description: e.target.value })}
              />
            </Field>
            <BotModelPicker bot={b} data={data} change={setB} />
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={b.enabled}
                onChange={(e) => setB({ ...b, enabled: e.target.checked })}
              />
              Ready to receive work
            </label>
          </>
        )}
        {tab === 'appearance' && (
          <>
            <Field label="Choose a character">
              <div className="shape-grid">
                {AVATAR_SHAPES.map((shape) => (
                  <button
                    className={b.avatar.shape === shape ? 'chosen' : ''}
                    key={shape}
                    type="button"
                    onClick={() => setB({ ...b, avatar: { ...b.avatar, shape } })}
                  >
                    <Avatar avatar={{ ...b.avatar, shape }} size={66} />
                    <span>{shape}</span>
                  </button>
                ))}
              </div>
            </Field>
            <div className="two-columns">
              <Field label="Body color">
                <div className="color-input">
                  <input
                    aria-label="Body color picker"
                    type="color"
                    value={b.avatar.color}
                    onChange={(e) => setB({ ...b, avatar: { ...b.avatar, color: e.target.value } })}
                  />
                  <input
                    aria-label="Body color hex"
                    value={b.avatar.color}
                    pattern="#[0-9a-fA-F]{6}"
                    onChange={(e) => setB({ ...b, avatar: { ...b.avatar, color: e.target.value } })}
                  />
                </div>
              </Field>
              <Field label="Face color">
                <div className="color-input">
                  <input
                    aria-label="Face color picker"
                    type="color"
                    value={b.avatar.accent}
                    onChange={(e) =>
                      setB({ ...b, avatar: { ...b.avatar, accent: e.target.value } })
                    }
                  />
                  <input
                    aria-label="Face color hex"
                    value={b.avatar.accent}
                    pattern="#[0-9a-fA-F]{6}"
                    onChange={(e) =>
                      setB({ ...b, avatar: { ...b.avatar, accent: e.target.value } })
                    }
                  />
                </div>
              </Field>
            </div>
            <p className="subtle">
              A little breathing, a little blinking. Motion follows your device’s accessibility
              preferences.
            </p>
          </>
        )}
        {tab === 'instructions' && (
          <Field label="Full operating instructions">
            <textarea
              className="code-input"
              rows={17}
              value={b.instructions}
              onChange={(e) => setB({ ...b, instructions: e.target.value })}
            />
            <small>
              Imported from {bot?.sourceFile ?? 'your own imagination'}. The original archive is
              preserved separately.
            </small>
          </Field>
        )}
        {tab === 'activity' && (
          <div className="phrase-editor">
            <p>
              Give {b.name || 'this bot'} a little working vocabulary. Phrases describe its current
              kind of work, and never claim a tool action succeeded.
            </p>
            <button
              type="button"
              className="secondary"
              disabled={suggesting}
              onClick={() => {
                setSuggesting(true);
                void api<{
                  phrases: ProcessingPhrases;
                  basis: { pastTasks: number; futureRoutines: number };
                }>('/bots/phrase-suggestions', 'POST', b)
                  .then(setSuggested, (e) => setError(e.message))
                  .finally(() => setSuggesting(false));
              }}
            >
              {suggesting ? 'Thinking of words…' : 'Suggest from instructions & experience'}
            </button>
            {suggested && (
              <div className="notice">
                <div>
                  <p>
                    Based on its instructions, {suggested.basis.pastTasks} past tasks and{' '}
                    {suggested.basis.futureRoutines} routines.
                  </p>
                  <p>{Object.values(suggested.phrases).flat().join(' · ')}</p>
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() => {
                      const merged = { ...b.processingPhrases };
                      for (const [key, value] of Object.entries(suggested.phrases))
                        merged[key as PhraseContext] = [
                          ...new Set([...(merged[key as PhraseContext] ?? []), ...value]),
                        ].slice(0, 20);
                      setB({ ...b, processingPhrases: merged });
                      setPhraseInputs(
                        Object.fromEntries(
                          Object.entries(merged).map(([context, items]) => [
                            context,
                            items.join('\n'),
                          ]),
                        ),
                      );
                      setSuggested(undefined);
                    }}
                  >
                    Use these suggestions
                  </button>
                </div>
              </div>
            )}
            {(
              [
                'general',
                'coding',
                'research',
                'writing',
                'planning',
                'waiting',
                'responding',
              ] as PhraseContext[]
            ).map((context) => (
              <Field key={context} label={`${context[0].toUpperCase() + context.slice(1)} phrases`}>
                <textarea
                  rows={2}
                  placeholder="One phrase per line"
                  value={phraseInputs[context] ?? ''}
                  onChange={(e) => {
                    setPhraseInputs({ ...phraseInputs, [context]: e.target.value });
                    setB({
                      ...b,
                      processingPhrases: {
                        ...b.processingPhrases,
                        [context]: e.target.value
                          .split('\n')
                          .map((x) => x.trim())
                          .filter(Boolean)
                          .slice(0, 20),
                      },
                    });
                  }}
                />
                <small>Up to 20 phrases, 70 characters each. Empty uses the team defaults.</small>
              </Field>
            ))}
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="modal-footer">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save your bot'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
