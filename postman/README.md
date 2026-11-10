# Login and marketplace Postman collection

Import `Margyn.postman_collection.json`. You can also import and select `Margyn.postman_environment.json` for the Render base URL:

`https://margyn-backend.onrender.com`

The collection contains 29 requests covering 25 route/method combinations: OTP login, products/images, public banners, delivery locations, profile/addresses, cart actions and orders. Each request includes saved response examples. `api-coverage.json` is a route inventory, not a Postman import file.

## Setup and login

1. In collection variables, set `phone` to your mobile number.
2. Set `origin` in the selected environment, or in collection variables if no environment is selected. For the current Render deployment, use `http://localhost:3000`: this was accepted by the deployed API's preflight check on 11 November 2026. Keep `baseUrl` as `https://margyn-backend.onrender.com`. These are separate settings; using the backend URL as `origin` currently returns 403. If the server's allowed origins change later, update this variable to match `FRONTEND_ORIGIN` or `ADMIN_ORIGIN`.
3. Send **POST /api/auth/request-otp**. The script saves `challengeId` and the returned `otp` as `otpCode` in temporary test mode. It also supports the local `developmentCode` field. With SMS delivery, enter the code delivered to your phone.
4. Send **POST /api/auth/verify-otp**. Keep Postman's cookie jar enabled. Authentication uses the `margyn_session` cookie; you do not need a bearer token.
5. Send **GET /api/auth/me** to check the signed-in account. **POST /api/auth/logout** clears the session.

## Shopping flow

1. Send **GET /api/products**. The script captures an available `catalogProductId`, its first `productSize` and minimum `cartonQuantity`. You can change those variables to select another product or quantity.
2. Open **Add product to cart** and send it. Other cart requests update quantities, save/remove lines and apply/remove coupons. The cart works for guests too; login merges a guest cart into the customer account.
3. Read **GET /api/cart**. The script saves the latest `cartLineId` and `cartTotal`.
4. Use **Profile and saved addresses** to save an address, or fill the address in **POST /api/orders** directly.
5. Send **POST /api/orders** while signed in. Its `expectedTotal` uses the most recently captured `cartTotal`; refresh the cart after making changes. This endpoint creates an unpaid order request. It does not perform an online payment.
6. Read **GET /api/orders/mine** or **GET /api/orders/:id**. Created/listed order IDs are captured automatically. The `idempotencyKey` uses a fresh Postman GUID; retain a fixed key if retrying the same order intent.

Captured IDs and totals are stored as **collection variables**. The optional environment contains only `baseUrl` and `origin`, so it does not shadow them. The sample `mediaId` is for the legacy media endpoint and must be replaced with an actual media record ID if used.

Responses are illustrative examples derived from the backend source, not captured production records. IDs, dates, prices and contents will vary. Open a request's saved examples to see success/error responses. The media endpoint can redirect to ImageKit or return image bytes.

## Fixing an Origin error

In the **active Postman environment**, set:

```json
{
  "baseUrl": "https://margyn-backend.onrender.com",
  "origin": "http://localhost:3000"
}
```

For login and other write requests, keep one `Origin` header with value `{{origin}}`. Check for an extra manually entered Origin header. The active environment overrides a collection variable with the same name, so changing only the collection's `origin` does not change an environment override.

The deployed browser storefront is `https://margyn-2026-inky.vercel.app`. To enable its login, set the Render backend's `FRONTEND_ORIGIN` to `http://localhost:3000,https://margyn-2026-inky.vercel.app` and save/redeploy. After that, Postman can use either listed origin. Browser requests always use the storefront hostname; changing a Postman variable does not change the browser's Origin.

## Temporary OTP response mode

Set OTP_PROVIDER=test in the Render backend environment and redeploy the updated backend to return the OTP without SMS. Request OTP returns otp plus the legacy developmentCode alias; the collection saves that value as otpCode. The OTP still expires, is single-use and is checked by verify-otp. This temporary mode does not prove phone ownership; switch to twilio for real SMS login.
