import { Request, Response, Router } from "express";
import { check, FieldErrors, Length } from "../../util/instanceOf";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Config, UserModel } from "@fosscord/server-util";
import { adjustEmail } from "./register";
import RateLimit from "../../middlewares/RateLimit";

const router: Router = Router();
export default router;

// TODO: check if user is deleted --> prohibit login

router.post(
	"/",
	RateLimit({ count: 5, window: 60, onlyIp: true }),
	check({
		login: new Length(String, 2, 100), // email or telephone
		password: new Length(String, 8, 72),
		$undelete: Boolean,
		$captcha_key: String,
		$login_source: String,
		$gift_code_sku_id: String
	}),
	async (req: Request, res: Response) => {
		const { login, password, captcha_key, undelete } = req.body;
		const email = adjustEmail(login);
		const query: any[] = [{ phone: login }];
		if (email) query.push({ email });

		// TODO: Rewrite this to have the proper config syntax on the new method

		const config = Config.get();

		if (config.login.requireCaptcha && config.security.captcha.enabled) {
			if (!captcha_key) {
				const { sitekey, service } = config.security.captcha;
				return res.status(400).json({
					captcha_key: ["captcha-required"],
					captcha_sitekey: sitekey,
					captcha_service: service
				});
			}

			// TODO: check captcha
		}

		const user = await UserModel.findOne(
			{ $or: query },
			{
				user_data: {
					hash: true
				},
				id: true,
				user_settings: {
					locale: true,
					theme: true
				}
			}
		)
			.exec()
			.catch((e) => {
				throw FieldErrors({ login: { message: req.t("auth:login.INVALID_LOGIN"), code: "INVALID_LOGIN" } });
			});

		if (user.disabled && undelete) {
			// undelete refers to un'disable' here
			await UserModel.updateOne({ id: req.user_id }, { disabled: false }).exec();
		} else if (user.disabled) {
			return res.status(400).json({ message: req.t("auth:login.ACCOUNT_DISABLED"), code: 20013 });
		}

		// the salt is saved in the password refer to bcrypt docs
		const same_password = await bcrypt.compare(password, user.user_data.hash || "");
		if (!same_password) {
			throw FieldErrors({ password: { message: req.t("auth:login.INVALID_PASSWORD"), code: "INVALID_PASSWORD" } });
		}

		const token = await generateToken(user.id);

		// Notice this will have a different token structure, than discord
		// Discord header is just the user id as string, which is not possible with npm-jsonwebtoken package
		// https://user-images.githubusercontent.com/6506416/81051916-dd8c9900-8ec2-11ea-8794-daf12d6f31f0.png

		res.json({ token, user_settings: user.user_settings });
	}
);

export async function generateToken(id: string) {
	const iat = Math.floor(Date.now() / 1000);
	const algorithm = "HS256";

	return new Promise((res, rej) => {
		jwt.sign(
			{ id: id, iat },
			Config.get().security.jwtSecret,
			{
				algorithm
			},
			(err, token) => {
				if (err) return rej(err);
				return res(token);
			}
		);
	});
}

/**
 * POST /auth/login
 * @argument { login: "email@gmail.com", password: "cleartextpassword", undelete: false, captcha_key: null, login_source: null, gift_code_sku_id: null, }

 * MFA required:
 * @returns {"token": null, "mfa": true, "sms": true, "ticket": "SOME TICKET JWT TOKEN"}

 * Captcha required:
 * @returns {"captcha_key": ["captcha-required"], "captcha_sitekey": null, "captcha_service": "recaptcha"}

 * Sucess:
 * @returns {"token": "USERTOKEN", "user_settings": {"locale": "en", "theme": "dark"}}

 */
