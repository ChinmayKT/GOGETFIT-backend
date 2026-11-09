import mongoose from 'mongoose';

/** One account's like of one post. The unique index is what makes a like count once. */
const postLikeSchema = new mongoose.Schema(
  {
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false, collection: 'postlikes' },
);

postLikeSchema.index({ postId: 1, userId: 1 }, { unique: true, name: 'uniq_postlike_post_user' });
/** "Which of these posts have I liked" for a page of the Feed. */
postLikeSchema.index({ userId: 1, postId: 1 }, { name: 'postlike_user_post' });

export const PostLike = mongoose.model('PostLike', postLikeSchema);
export default PostLike;
