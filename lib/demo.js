import crypto from 'node:crypto';
import { store } from './store.js';

// The demo lets anyone try every Telly flow without a Buffer account. Each visitor gets a
// private practice queue that answers the same few GraphQL operations Telly sends to Buffer.
// Nothing here ever reaches Buffer or a social network. Demo data is removed after 7 days.

export const DEMO_ORG = 'org_demo';
const CHANNELS = [
  { id: 'demo_bsky', name: 'yourvenue.bsky.social', displayName: 'Your venue', service: 'bluesky', avatar: null, isDisconnected: false, isQueuePaused: false },
  { id: 'demo_mastodon', name: '@yourvenue@mastodon.social', displayName: 'Your venue', service: 'mastodon', avatar: null, isDisconnected: false, isQueuePaused: false },
];

export function startDemo(session) {
  session.tokens = undefined;
  session.demo = { id: `demo_${crypto.randomBytes(12).toString('base64url')}` };
  store.sweepDemos?.().catch(() => {});
}

const load = async (demoId) => (await store.getDemo(demoId)) ?? { posts: {}, seq: 1 };

function makeAsset(url, altText = '') {
  return { id: `asset_${crypto.randomBytes(6).toString('hex')}`, type: 'image', mimeType: 'image/png', source: url, image: { altText, width: 1080, height: 1080 } };
}

function viewPost(post) {
  // A scheduled post whose time has passed counts as sent, the way it would in Buffer.
  if (post.status === 'scheduled' && post.dueAt && Date.parse(post.dueAt) < Date.now()) return { ...post, status: 'sent' };
  return post;
}

export async function demoGql(session, query, variables = {}) {
  const demoId = session.demo.id;
  const account = { id: demoId, email: '', name: 'Demo organiser', organizations: [{ id: DEMO_ORG, name: 'Demo workspace' }] };
  if (/\baccount\s*\{/.test(query) && !/Post\s*\(/.test(query)) return { account };
  if (/\bchannels\s*\(/.test(query)) return { channels: CHANNELS };

  const state = await load(demoId);
  const save = () => store.putDemo(demoId, state);

  if (/createPost\s*\(/.test(query)) {
    const input = variables.input;
    if (Object.keys(state.posts).length >= 60) return { createPost: { message: 'The demo queue is full. Delete some campaigns first.' } };
    const now = new Date().toISOString();
    const id = `demo_post_${state.seq++}`;
    const image = input.assets?.[0]?.image;
    state.posts[id] = {
      id, text: String(input.text || ''), status: 'scheduled', dueAt: input.dueAt, updatedAt: now,
      shareMode: 'customScheduled', isCustomScheduled: true, channelId: input.channelId,
      channelService: CHANNELS.find((c) => c.id === input.channelId)?.service ?? 'bluesky',
      assets: image ? [makeAsset(image.url, image.metadata?.altText)] : [],
    };
    await save();
    return { createPost: { post: state.posts[id] } };
  }
  if (/editPost\s*\(/.test(query)) {
    const input = variables.input;
    const post = state.posts[input.id];
    if (!post) return { editPost: { message: 'Post not found' } };
    if (viewPost(post).status !== 'scheduled') return { editPost: { message: 'This post was already published.' } };
    if (typeof input.text === 'string') post.text = input.text;
    if (input.dueAt) post.dueAt = input.dueAt; // like Buffer: the time changes only when sent
    if (Array.isArray(input.assets)) post.assets = input.assets.map((a) => makeAsset(a.image.url, a.image.metadata?.altText));
    post.updatedAt = new Date().toISOString();
    await save();
    return { editPost: { post } };
  }
  if (/createIdea\s*\(/.test(query)) {
    const content = variables.input?.content || {};
    state.ideas = state.ideas || [];
    if (state.ideas.length >= 60) return { createIdea: { __typename: 'LimitReachedError', message: 'The demo has enough ideas saved.' } };
    const idea = { id: `demo_idea_${state.seq++}`, title: String(content.title || ''), text: String(content.text || '') };
    state.ideas.push(idea);
    await save();
    return { createIdea: { __typename: 'Idea', id: idea.id } };
  }
  if (/(create|update)Snippet\s*\(/.test(query)) {
    const input = variables.input || {};
    state.snippets = state.snippets || {};
    const updating = /updateSnippet\s*\(/.test(query);
    if (updating && !state.snippets[input.id]) return { updateSnippet: { __typename: 'VoidMutationError', message: 'Snippet not found' } };
    const id = updating ? input.id : `demo_snippet_${state.seq++}`;
    state.snippets[id] = { id, name: String(input.name || ''), text: String(input.text || '') };
    await save();
    const key = updating ? 'updateSnippet' : 'createSnippet';
    return { [key]: { __typename: updating ? 'UpdateSnippetSuccess' : 'CreateSnippetSuccess', snippet: state.snippets[id] } };
  }
  if (/query PostsBatch/.test(query)) {
    // Like Buffer: each alias answers on its own, and a missing post is an error for that alias only.
    const out = { __errors: [] };
    for (const [key, id] of Object.entries(variables)) {
      const alias = `p${key.slice(2)}`;
      const post = state.posts[id];
      out[alias] = post ? viewPost(post) : null;
      if (!post) out.__errors.push({ message: 'Post not found', path: [alias] });
    }
    return out;
  }
  if (/deletePost\s*\(/.test(query)) {
    delete state.posts[variables.input.id];
    await save();
    return { deletePost: { __typename: 'DeletePostSuccess', id: variables.input.id } };
  }
  if (/\bpost\s*\(/.test(query)) {
    const post = state.posts[variables.id];
    if (!post) throw Object.assign(new Error('Post not found'), { demoNotFound: true });
    return { post: viewPost(post) };
  }
  throw new Error('The demo does not support this operation');
}

// Practice actions: do in the demo what an organiser might do directly in Buffer, so the
// hand-edit, published and removed cases can be seen without a real account.
export async function practice(session, postId, action, text) {
  const state = await load(session.demo.id);
  const post = state.posts[postId];
  if (!post) return null;
  if (action === 'edit') {
    const value = String(text ?? '').trim().slice(0, 2000);
    if (!value) return null;
    post.text = value;
  } else if (action === 'publish') {
    post.status = 'sent';
  } else if (action === 'remove') {
    delete state.posts[postId];
  } else {
    return null;
  }
  post.updatedAt = new Date().toISOString();
  await store.putDemo(session.demo.id, state);
  return action === 'remove' ? { removed: true } : { post: viewPost(post) };
}
