import mongoose from 'mongoose';

/**
 * One coaching plan a member has put in their cart.
 *
 * The cart lives on the server, not in the app: it has to survive a restart, a
 * logout, a reinstall and a change of device, and the sales team has to be able
 * to see who added a plan without buying it ("In cart" on the Admin Portal).
 *
 * Nothing about the coach or the plan is copied here. Only the references are
 * stored and the live documents are resolved at read time, so a price change or
 * an archived plan is reflected immediately instead of being frozen into the
 * cart. The price the member actually pays is worked out at purchase, by the
 * server, from the plan as it stands then.
 *
 * A purchased item is DELETED, in the same transaction that creates its
 * enrollment: the enrolledclients document is the record of the purchase, so
 * nothing bought stays behind in the cart collection. Only `active` items are
 * a cart.
 */

/**
 * active    - in the cart, not yet bought
 * purchased - no longer written (purchases delete the item). Kept in the enum
 *             only so a row from the earlier behaviour still loads.
 * removed   - the member took it out of the cart
 *
 * Only `active` appears in the member's cart and in the admin "In cart" list.
 */
export const CART_ITEM_STATUSES = ['active', 'purchased', 'removed'];

const cartItemSchema = new mongoose.Schema(
  {
    /** The owner. Always taken from the authenticated token, never from the client. */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** The coach whose plan this is. */
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach', required: true },
    /** The GoGetFit plan being bought. */
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'GogetfitPlan', required: true },

    status: { type: String, enum: CART_ITEM_STATUSES, default: 'active' },

    /** When the member added it - the figure the sales follow-up list sorts by. */
    addedAt: { type: Date, default: () => new Date() },

    /** Set when the item became an enrollment. Null while it is still a cart item. */
    purchasedAt: { type: Date, default: null },
    enrolledClientId: { type: mongoose.Schema.Types.ObjectId, ref: 'EnrolledClient', default: null },

    /** When the member removed it, for the same reason purchased items are kept. */
    removedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'cartitems' },
);

/**
 * One active entry per member, coach and plan.
 *
 * Partial, so the uniqueness applies to the cart only: a member may buy the same
 * plan from the same coach again later, and that second purchase leaves a second
 * `purchased` row behind. Enforced by the database rather than by a read-then-write
 * check, which two taps in quick succession would race past.
 */
cartItemSchema.index(
  { userId: 1, coachId: 1, planId: 1 },
  {
    unique: true,
    name: 'uniq_active_cart_entry',
    partialFilterExpression: { status: 'active' },
  },
);

/** The member's own cart, newest first. */
cartItemSchema.index({ userId: 1, status: 1, addedAt: -1 }, { name: 'cart_user_status' });
/** The admin "In cart" list, and its coach/plan filters. */
cartItemSchema.index({ status: 1, addedAt: -1 }, { name: 'cart_status_added' });
cartItemSchema.index({ coachId: 1, status: 1 }, { name: 'cart_coach_status' });
cartItemSchema.index({ planId: 1, status: 1 }, { name: 'cart_plan_status' });

export const CartItem = mongoose.model('CartItem', cartItemSchema);
export default CartItem;
