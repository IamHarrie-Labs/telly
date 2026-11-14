// GraphQL documents shared by the routes. Kept in one place so the shape Telly depends on is easy to audit.

export const POST_FIELDS = /* GraphQL */ `
  id
  text
  status
  dueAt
  updatedAt
  shareMode
  isCustomScheduled
  channelId
  channelService
  assets {
    id
    type
    mimeType
    source
    ... on ImageAsset {
      image {
        altText
        width
        height
      }
    }
  }
`;

export const ACCOUNT_ID = /* GraphQL */ `
  query AccountId {
    account {
      id
    }
  }
`;

export const CHANNELS = /* GraphQL */ `
  query Channels($organizationId: OrganizationId!) {
    channels(input: { organizationId: $organizationId }) {
      id
      name
      displayName
      service
      avatar
      isDisconnected
      isQueuePaused
    }
  }
`;

export const GET_POST = /* GraphQL */ `
  query GetPost($id: PostId!) {
    post(input: { id: $id }) {
      ${POST_FIELDS}
    }
  }
`;

export const CREATE_POST = /* GraphQL */ `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess {
        post {
          ${POST_FIELDS}
        }
      }
      ... on MutationError {
        message
      }
    }
  }
`;

export const EDIT_POST = /* GraphQL */ `
  mutation EditPost($input: EditPostInput!) {
    editPost(input: $input) {
      ... on PostActionSuccess {
        post {
          ${POST_FIELDS}
        }
      }
      ... on MutationError {
        message
      }
    }
  }
`;

export const DELETE_POST = /* GraphQL */ `
  mutation DeletePost($input: DeletePostInput!) {
    deletePost(input: $input) {
      __typename
      ... on DeletePostSuccess {
        id
      }
      ... on MutationError {
        message
      }
    }
  }
`;

// Who is signed in, and which Buffer organizations they belong to (for shared campaigns).
export const ACCOUNT_ME = /* GraphQL */ `
  query AccountMe {
    account {
      id
      name
      organizations {
        id
      }
    }
  }
`;

/** Reads up to 25 posts in one request, using one alias per post: p0, p1, ... */
export function postsBatch(ids) {
  const vars = ids.map((_, i) => `$id${i}: PostId!`).join(', ');
  const fields = ids.map((_, i) => `p${i}: post(input: { id: $id${i} }) {\n${POST_FIELDS}\n}`).join('\n');
  return {
    query: `query PostsBatch(${vars}) {\n${fields}\n}`,
    variables: Object.fromEntries(ids.map((id, i) => [`id${i}`, id])),
  };
}

// Buffer Ideas and Snippets. These need the ideas:write and snippets:write scopes, so they are
// only offered when TELLY_IDEAS=1 (and always in the demo, which never talks to Buffer).
export const CREATE_IDEA = /* GraphQL */ `
  mutation CreateIdea($input: CreateIdeaInput!) {
    createIdea(input: $input) {
      __typename
      ... on Idea {
        id
      }
      ... on MutationError {
        message
      }
    }
  }
`;

export const CREATE_SNIPPET = /* GraphQL */ `
  mutation CreateSnippet($input: CreateSnippetInput!) {
    createSnippet(input: $input) {
      __typename
      ... on CreateSnippetSuccess {
        snippet {
          id
          name
          text
        }
      }
      ... on MutationError {
        message
      }
    }
  }
`;

export const UPDATE_SNIPPET = /* GraphQL */ `
  mutation UpdateSnippet($input: UpdateSnippetInput!) {
    updateSnippet(input: $input) {
      __typename
      ... on UpdateSnippetSuccess {
        snippet {
          id
          name
          text
        }
      }
      ... on MutationError {
        message
      }
    }
  }
`;
