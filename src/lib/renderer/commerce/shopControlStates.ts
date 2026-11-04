// src/lib/renderer/commerce/shopControlStates.ts
//
// Per shop control, which canvas preview state shows a part: ShopPreviewBar uses
// it to switch the canvas to a state that shows a part selected while hidden.
// Each answer comes from the control's own part function with its sample data, so
// it is exactly what the canvas draws.

import type { ShopControlKind, ShopLocale } from '@/lib/commerce/parts';
import { checkoutStateShowing, checkoutStateShows } from './CheckoutButton';
import { addToCartStateShowing, addToCartStateShows } from './AddToCartButton';
import { cartStateShowing, cartStateShows } from './CartView';

interface StateLookup {
  shows(id: string, roles: readonly string[], locale: ShopLocale): boolean;
  showing(roles: readonly string[], locale: ShopLocale): string | undefined;
}

export const SHOP_STATE_LOOKUP: Readonly<Record<ShopControlKind, StateLookup>> = {
  'checkout-button': { shows: checkoutStateShows, showing: checkoutStateShowing },
  'add-to-cart': { shows: addToCartStateShows, showing: addToCartStateShowing },
  'cart-view': { shows: cartStateShows, showing: cartStateShowing },
};
