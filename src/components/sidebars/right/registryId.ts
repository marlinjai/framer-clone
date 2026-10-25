// The component registry id of a node, for looking up its bindable slots
// (the Data section and the Text section both need it).
import type { ComponentInstance } from '@/models/ComponentModel';
import { getComponentEntry } from '@/lib/componentRegistry';

/**
 * Resolve the registry id for a node so we can look up its bindable slots.
 * Nodes are created as `${registryId}-${uuid}`, so the id prefix is the most
 * reliable signal; we fall back to the data-component marker and then the
 * intrinsic html type for hand-built nodes.
 */
export function getRegistryIdForNode(node: ComponentInstance): string | undefined {
  const idPrefix = node.id.split('-')[0];
  if (getComponentEntry(idPrefix)) return idPrefix;

  const kind = (node.props as Record<string, unknown> | undefined)?.['data-component-kind'];
  if (kind === 'collection') return 'collection';
  if (kind === 'record-view') return 'recordView';
  if (kind === 'table-view') return 'tableView';

  switch (node.type) {
    case 'p':
      return 'text';
    case 'button':
      return 'button';
    case 'img':
      return 'image';
    default:
      return undefined;
  }
}
