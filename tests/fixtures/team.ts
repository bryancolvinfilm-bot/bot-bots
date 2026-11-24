import { seedStarterTeam } from '../../apps/server/starter-team';
import { Store } from '../../apps/server/store';
import { AVATAR_SHAPES } from '../../packages/shared/types';

/** Synthetic test data, authored independently of any user's saved bot profiles. */
export function seedTestTeam(store: Store, _source?: string) {
  seedStarterTeam(store);
  if (store.config('synthetic-test-team')) return;
  const now = new Date().toISOString();
  const names = [
    'Boss Man',
    'Calendar',
    'Comparison',
    'Contacts',
    'Family Events',
    'Film Edit Jobs',
    'Film Networking',
    'Info Page Generate',
    'Real Estate',
    'Research',
    'Social Media',
    'Texting',
    'Worker1',
    'Worker2',
    'Worker3',
  ];
  const ids = names.map((name) => name.toLowerCase().replace(/\s+/g, '-'));
  names.forEach((name, index) => {
    const id = ids[index];
    store.put('bots', {
      id,
      name,
      title: `Test ${name}`,
      description: 'Synthetic test teammate.',
      instructions: `You are ${name}, a synthetic test teammate. Focus on your assigned role. Use the available tools and return actual results. Delegate appropriate work to the correct teammate.`,
      avatar: {
        shape: AVATAR_SHAPES[index % AVATAR_SHAPES.length],
        color: '#aabbcc',
        accent: '#223344',
      },
      modelId: null,
      enabled: true,
    });
    store.put('memory', {
      id: `fixture-memory-${index}`,
      botId: id,
      category: 'behavior',
      content: 'Keep reports concise and distinguish verified actions from plans.',
      createdAt: now,
    });
    if (index < 12)
      store.put('routines', {
        id: `fixture-routine-${index}`,
        botId: id,
        name: `Test schedule ${index}`,
        cron: '0 9 * * 1',
        timezone: 'UTC',
        prompt: 'Review the test task queue.',
        enabled: false,
      });
  });
  for (let index = 0; index < 8; index++) {
    const id = index === 0 ? 'publish-public-page' : `fixture-playbook-${index}`;
    store.put('skills', {
      id,
      name: id,
      content:
        index === 0
          ? '# Public page publishing\n\nSave and preview HTML. Use a connected publishing API such as bottools.online only when the user requests publication. Credentials stay in the host store.'
          : `# Synthetic playbook ${index}\n\nReport real results and follow the assigned task.`,
    });
  }
  store.setConfig('synthetic-test-team', true);
}
