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
