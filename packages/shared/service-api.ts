export interface ApiOperation {
  id: string;
  label: string;
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body: 'none' | 'json' | 'page-zip';
  inputFields?: string[];
  queryFields?: string[];
}
export interface ServiceApi {
  id: string;
  name: string;
  baseUrl: string;
  authType: 'bearer' | 'header';
  header?: string;
  operations: ApiOperation[];
}
export interface ServiceConnection {
  id: string;
  api: ServiceApi;
  enabled: boolean;
  botIds: string[];
  approval: 'connected';
}
export const PAGES_API: ServiceApi = {
  id: 'bottools-pages',
  name: 'Bottools Pages',
  baseUrl: 'https://bottools.online/nettools/webhost',
  authType: 'bearer',
  operations: [
    { id: 'info', label: 'API information', method: 'GET', path: '/api/v1', body: 'none' },
    { id: 'list-sites', label: 'List sites', method: 'GET', path: '/api/v1/sites', body: 'none' },
    {
      id: 'create-site',
      label: 'Create a site',
      method: 'POST',
      path: '/api/v1/sites',
      body: 'json',
      inputFields: ['name', 'slug'],
    },
    {
      id: 'get-site',
      label: 'Read site',
      method: 'GET',
      path: '/api/v1/sites/{site}',
      body: 'none',
    },
    {
      id: 'update-site',
      label: 'Update pinning or expiration',
      method: 'PATCH',
      path: '/api/v1/sites/{site}',
      body: 'json',
      inputFields: ['pinned', 'ttl_days', 'sso_login'],
    },
    {
      id: 'delete-site',
      label: 'Delete site',
      method: 'DELETE',
      path: '/api/v1/sites/{site}',
      body: 'none',
    },
    {
      id: 'list-deploys',
      label: 'List deployments',
      method: 'GET',
      path: '/api/v1/sites/{site}/deploys',
      body: 'none',
    },
    {
      id: 'deploy',
      label: 'Deploy saved page as a ZIP',
      method: 'POST',
      path: '/api/v1/sites/{site}/deploys',
      body: 'page-zip',
    },
    {
      id: 'rollback',
      label: 'Roll back deployment',
      method: 'POST',
      path: '/api/v1/sites/{site}/rollback',
      body: 'json',
      inputFields: ['deployment_id'],
    },
    {
      id: 'list-links',
      label: 'List short links',
      method: 'GET',
      path: '/api/v1/short-links',
      body: 'none',
    },
    {
      id: 'create-link',
      label: 'Create short link',
      method: 'POST',
      path: '/api/v1/short-links',
      body: 'json',
      inputFields: ['site', 'url', 'length', 'ttl_days'],
    },
    {
      id: 'get-link',
      label: 'Inspect short link',
      method: 'GET',
      path: '/api/v1/short-links/{code}',
      body: 'none',
    },
    {
      id: 'delete-link',
      label: 'Delete short link',
      method: 'DELETE',
      path: '/api/v1/short-links/{code}',
      body: 'none',
    },
  ],
};
export const pagesServiceName = (name: string) =>
  /^(?:pages(?: publishing)?|bottools(?: pages)?|bottools\.online|nettools(?: pages)?|bottools nettools)$/i.test(
    name.trim(),
  );
for (const operation of [...PAGES_API.operations])
  if (operation.method === 'GET')
    PAGES_API.operations.push({
      ...operation,
      id: `head-${operation.id}`,
      label: `Headers: ${operation.label}`,
      method: 'HEAD',
    });
export function knownApi(text: string): ServiceApi | undefined {
  return /(?:^|[\s"'(<])(?:https?:\/\/)?bottools\.online\/(?:nettools\/webhost|s\/)/i.test(text) ||
    pagesServiceName(text)
    ? PAGES_API
    : undefined;
}
