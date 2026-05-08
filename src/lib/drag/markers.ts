// Central constants for the data-attributes the drop resolver walks.
// Kept in one place so a typo in one file doesn't silently break drop targeting
// (the resolver would walk up past a mistyped attribute and miss the container).
//
// Attribute responsibilities:
// - DATA_VIEWPORT_ID:         the div with the viewport frame (drop here = append to appTree)
// - DATA_FLOATING_ROOT_ID:    the wrapper around a floating element subtree
// - DATA_INNER_COMPONENT_ID:  any rendered component inside the app tree or a floating subtree
// - DATA_GROUND:              the canvas ground div (drop here = new floating)
// - DATA_EDITOR_UI:           any chrome element (toolbar, sidebar, header). Dropping here cancels.
// - DATA_GROUND_WRAPPER_ID:   the outermost fixed-position wrapper around every canvas node
//                             (floating element AND viewport frame). Not walked by the resolver
//                             directly, but used as an additional source-root marker so
//                             live-mode drags (which reposition this wrapper to track the
//                             cursor) can be skipped past during hit testing.

export const DATA_VIEWPORT_ID = 'data-viewport-id';
export const DATA_FLOATING_ROOT_ID = 'data-floating-root-id';
export const DATA_INNER_COMPONENT_ID = 'data-inner-component-id';
export const DATA_GROUND = 'data-ground';
export const DATA_EDITOR_UI = 'data-editor-ui';
export const DATA_GROUND_WRAPPER_ID = 'data-ground-wrapper-id';
