import mongoose from 'mongoose';

/** One account's private bookmark of one post. */
const postSaveSchema = new mongoose.Schema(
  {
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false, collection: 'postsaves' },
);

postSaveSchema.index({ userId: 1, postId: 1 }, { unique: true, name: 'uniq_postsave_user_post' });
/** Saved Posts, most recently saved first. */
postSaveSchema.index({ userId: 1, createdAt: -1, _id: -1 }, { name: 'postsave_user_recent' });

export const PostSave = mongoose.model('PostSave', postSaveSchema);
export default PostSave;
