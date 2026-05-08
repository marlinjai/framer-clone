// src/lib/multiplayer/index.ts
//
// Public barrel for the multiplayer lib. Live binding, sync server, and
// presence layers are landing in subsequent specs; for now this module
// only exposes the Yjs document shape contract.

export {
  YJS_DOC_SCHEMA_VERSION,
  YJS_KEYS,
  YJS_NODE_KEYS,
  YJS_PAGE_KEYS,
  YJS_PROJECT_KEYS,
  YJS_PROPS_KEYS,
  createEmptyProjectYDoc,
  getChildrenArray,
  getNodeMap,
  getPageMap,
  mstSnapshotToYDoc,
  yDocToMstSnapshot,
} from './yjsDocShape';
export type { YBreakpointInfo, YProjectMeta } from './yjsDocShape';
