import { requestOtp, verifyOtpAndLogin } from '../services/auth.service.js';
import { validateRequestOtp, validateVerifyOtp } from '../validators/auth.validator.js';

export const postRequestOtp = async (req, res, next) => {
  try {
    const { phone } = validateRequestOtp(req.body);
    const result = await requestOtp(phone);

    const body = {
      success: true,
      message: 'OTP sent',
      data: {
        phone: result.phone,
        isNewUser: result.isNewUser,
        expiresAt: result.expiresAt.toISOString(),
      },
    };

    if (result.devOtp !== undefined) body.data.devOtp = result.devOtp;

    res.status(200).json(body);
  } catch (error) {
    next(error);
  }
};

export const postVerifyOtp = async (req, res, next) => {
  try {
    const { phone, otp } = validateVerifyOtp(req.body);
    const result = await verifyOtpAndLogin(phone, otp);

    res.status(result.isNewUser ? 201 : 200).json({
      success: true,
      message: result.isNewUser ? 'Account created' : 'Logged in',
      data: { token: result.token, isNewUser: result.isNewUser, user: result.user },
    });
  } catch (error) {
    next(error);
  }
};
