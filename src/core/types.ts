// Row types the core hands to the ops layer (ops does not import store/ directly).
export type {
  GrantRow,
  GroupRow,
  Kind,
  PrincipalRole,
  PrincipalRow,
  Role,
  SpaceRow,
  TokenRow,
  Trust,
} from '../store/types.js';
