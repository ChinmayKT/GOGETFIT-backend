import mongoose from 'mongoose';

/**
 * A transformation image a coach submitted for GOGETFIT: the image, its title,
 * who sent it and when. Only added to - there is no review or publishing
 * workflow; admins just see what coaches sent.
 */
export const TRANSFORMATION_TITLE_MAX = 100;

const transformationSchema = new mongoose.Schema(
  {
    /** The submitting coach - always the token's, never sent by the app. */
    coachId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coach', required: true, immutable: true },
    /** The member it is of - checked to be one of this coach's clients. */
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    title: { type: String, required: true, trim: true, maxlength: TRANSFORMATION_TITLE_MAX },
    image: {
      url: { type: String, required: true },
      storageKey: { type: String, required: true },
    },
    submittedAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false, collection: 'coachtransformations' },
);

transformationSchema.index({ submittedAt: -1, _id: -1 }, { name: 'coachtransformation_newest' });

export const CoachTransformation = mongoose.model('CoachTransformation', transformationSchema);
export default CoachTransformation;
