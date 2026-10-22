// src/lib/api.js
// Talks to the Customer Connect API. The token lives in localStorage; a 401
// signs the user out.

const TOKEN_KEY = 'cc_token';
let onSignedOut = () => {};

export const auth = {
  getToken: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  setToken: (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ } },
  onSignedOut: (fn) => { onSignedOut = fn; },
};

function query(params = {}) {
  const clean = Object.entries(params).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0));
  const qs = new URLSearchParams(clean.map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])).toString();
  return qs ? `?${qs}` : '';
}

async function request(method, path, body, { form, raw } = {}) {
  const token = auth.getToken();
  const res = await fetch(path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
    },
    body: form || (body ? JSON.stringify(body) : undefined),
    cache: 'no-store',
  });
  if (res.status === 401 && path !== '/api/auth/login') {
    auth.setToken(null);
    onSignedOut('Your session has ended. Please sign in again.');
  }
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const get = (path, params) => request('GET', path + query(params));
const post = (path, body) => request('POST', path, body);
const put = (path, body) => request('PUT', path, body);
const patch = (path, body) => request('PATCH', path, body);
const del = (path) => request('DELETE', path);

const api = {
  login: (email, password, remember) => post('/api/auth/login', { email, password, remember }),
  me: () => get('/api/auth/me'),
  changePassword: (currentPassword, newPassword) => post('/api/auth/me/password', { currentPassword, newPassword }),
  users: () => get('/api/users'),
  addUser: (u) => post('/api/users', u),
  updateUser: (id, u) => put(`/api/users/${id}`, u),

  status: () => get('/api/status'),
  outbox: () => get('/api/outbox'),
  syncChatSupport: (full = false) => post('/api/chat-support/sync', { full }),

  groups: () => get('/api/groups'),
  stores: (storeGroup) => get('/api/stores', { storeGroup }),
  addStore: (s) => post('/api/stores', s),
  updateStore: (id, s) => put(`/api/stores/${id}`, s),
  deleteStore: (id) => del(`/api/stores/${id}`),
  addStores: (stores, shared = {}) => post('/api/stores/bulk', { stores, ...shared }),
  waitingStores: () => get('/api/stores/waiting'),
  assignStores: (domains, storeId) => post('/api/stores/assign', { domains, storeId }),
  removeStoreRule: (domain) => del(`/api/stores/aliases/${encodeURIComponent(domain)}`),
  storesBatch: (ids, action, extra = {}) => post('/api/stores/batch', { ids, action, ...extra }),
  segments: (storeGroup) => get('/api/segments', { storeGroup }),
  saveSegment: (s) => put('/api/segments', s),
  deleteSegment: (id) => del(`/api/segments/${id}`),

  customers: (params) => get('/api/customers', params),
  addCustomer: (c) => post('/api/customers', c),
  updateCustomer: (id, c) => put(`/api/customers/${id}`, c),
  archiveCustomer: (id) => post(`/api/customers/${id}/archive`),
  restoreCustomer: (id) => post(`/api/customers/${id}/restore`),
  deleteCustomer: (id) => del(`/api/customers/${id}`),
  customerHistory: (id) => get(`/api/customers/${id}/history`),
  csvTemplate: async () => (await request('GET', '/api/customers/import/template', null, { raw: true })).blob(),
  importCustomers: (file, apply) => {
    const form = new FormData();
    form.append('file', file);
    return request('POST', `/api/customers/import${apply ? '?apply=1' : ''}`, null, { form });
  },
  customersBatch: (action, selection, extra = {}) => post('/api/customers/batch', { action, selection, ...extra }),
  exportSelected: async (selection) => (await request('POST', '/api/customers/export', { selection }, { raw: true })).blob(),
  exportCustomers: async (params) => {
    const res = await request('GET', `/api/customers/export${query(params)}`, null, { raw: true });
    return res.blob();
  },
  audience: (params) => get('/api/audience', params),
  sent: (params) => get('/api/sent', params),
  resetSent: (ids) => post('/api/sent/reset', { ids }),
  optOuts: (search) => get('/api/opt-outs', { search }),
  addUnsubscribe: (email) => post('/api/opt-outs/unsubscribes', { email }),
  removeUnsubscribe: (id) => del(`/api/opt-outs/unsubscribes/${id}`),
  addBlock: (b) => post('/api/opt-outs/blocks', b),
  removeBlock: (id) => del(`/api/opt-outs/blocks/${id}`),
  removeOptOuts: (unsubscribeIds, blockIds) => post('/api/opt-outs/batch', { action: 'remove', unsubscribeIds, blockIds }),

  templates: (storeGroup) => get('/api/templates', { storeGroup }),
  template: (id) => get(`/api/templates/${id}`),
  createTemplate: (t) => post('/api/templates', t),
  updateTemplate: (id, t) => put(`/api/templates/${id}`, t),
  deleteTemplate: (id) => del(`/api/templates/${id}`),
  deleteTemplates: (ids) => post('/api/templates/batch', { action: 'delete', ids }),
  testSend: (payload) => post('/api/test-send', payload),

  campaigns: (storeGroup) => get('/api/campaigns', { storeGroup }),
  campaign: (id) => get(`/api/campaigns/${id}`),
  createCampaign: (c) => post('/api/campaigns', c),
  updateCampaign: (id, changes) => patch(`/api/campaigns/${id}`, changes),
  campaignAction: (id, action) => post(`/api/campaigns/${id}/${action}`),
  deleteCampaign: (id) => del(`/api/campaigns/${id}`),
  campaignsBatch: (ids, action) => post('/api/campaigns/batch', { ids, action }),
};

export default api;
