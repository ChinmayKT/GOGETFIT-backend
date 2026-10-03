import {
  addToCart,
  listCart,
  listMemberCoupons,
  purchaseCartItem,
  quoteCartItem,
  removeFromCart,
} from '../services/cart.service.js';
import { getEnrolledClientById } from '../services/enrolled-client.service.js';
import { ERROR_CODES, notFound } from '../utils/errors.js';
import { validateAddToCart, validatePurchase, validateQuote } from '../validators/cart.validator.js';

/**
 * The member's own cart. Every handler takes the owner from `req.user._id`,
 * which `requireAuth` put there from the verified token - a userId in the body
 * or the query is never read.
 */

const cartItemNotFound = () => notFound(ERROR_CODES.CART_ITEM_NOT_FOUND, 'Cart item not found');

/** GET /api/users/me/cart */
export const getCart = async (req, res, next) => {
  try {
    const cart = await listCart(req.user._id);
    res.status(200).json({ success: true, data: cart });
  } catch (error) {
    next(error);
  }
};

/** POST /api/users/me/cart */
export const postCartItem = async (req, res, next) => {
  try {
    const item = await addToCart(req.user._id, validateAddToCart(req.body));
    res.status(201).json({ success: true, message: 'Added to cart', data: { item } });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/users/me/cart/:cartItemId */
export const deleteCartItem = async (req, res, next) => {
  try {
    const item = await removeFromCart(req.user._id, req.params.cartItemId);
    if (!item) throw cartItemNotFound();
    res.status(200).json({ success: true, message: 'Removed from cart', data: { item } });
  } catch (error) {
    next(error);
  }
};

/** GET /api/users/me/coupons - the public, currently valid coupons only. */
export const getMemberCoupons = async (req, res, next) => {
  try {
    const coupons = await listMemberCoupons();
    res.status(200).json({ success: true, data: { coupons } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/users/me/cart/:cartItemId/quote
 *
 * The authoritative total for one item, with an optional coupon. The app shows
 * what this returns; it never works out a discount itself.
 */
export const postCartQuote = async (req, res, next) => {
  try {
    const quote = await quoteCartItem(req.user._id, req.params.cartItemId, validateQuote(req.body));
    if (!quote) throw cartItemNotFound();
    res.status(200).json({ success: true, data: { item: quote } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/users/me/cart/:cartItemId/purchase
 *
 * Creates the enrollment and takes the item out of the cart, in one
 * transaction. Idempotent on paymentReference: a retry returns the enrollment
 * the first attempt created rather than making a second.
 */
export const postCartPurchase = async (req, res, next) => {
  try {
    const result = await purchaseCartItem(req.user._id, req.params.cartItemId, validatePurchase(req.body));
    if (!result) throw cartItemNotFound();

    const enrolledClient = await getEnrolledClientById(result.enrolledClientId);
    res.status(result.idempotent ? 200 : 201).json({
      success: true,
      message: result.idempotent ? 'Purchase already recorded' : 'Purchase complete',
      data: { enrolledClient, pricing: result.pricing ?? null, idempotent: result.idempotent },
    });
  } catch (error) {
    next(error);
  }
};
