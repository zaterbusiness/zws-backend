import axios from 'axios'

export const sendBrevoEmail = ({ to, subject, html }) =>
  axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender:      { name: 'Zater Web Studio', email: process.env.BREVO_SENDER_EMAIL },
      to:          [{ email: to }],
      subject,
      htmlContent: html,
    },
    { headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' } }
  )

export const sendWelcomeEmail = ({ to, name }) =>
  sendBrevoEmail({
    to,
    subject: 'Welcome to Zater Web Studio 🚀 Your 100 Free Credits Are Ready!',
    html: `
      <body style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f4f8;margin:0;padding:20px;">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

          <!-- Header -->
          <div style="background:#0a0a12;padding:28px 24px;text-align:center;">
            <h1 style="color:#fff;margin:0;font-size:22px;font-weight:800;">
              Zater Web Studio
            </h1>
            <p style="color:#a8a8b5;margin:8px 0 0;font-size:13px;">
              Build Your Website. Just Describe It.
            </p>
          </div>

          <!-- Content -->
          <div style="padding:32px 28px;">

            <h2 style="color:#0a0a12;margin:0 0 12px;font-size:22px;">
              Hi ${name}, welcome to ZWS! 🚀
            </h2>

            <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 20px;">
              Your Zater Web Studio account is ready. As a new user, you've received
              <strong>100 FREE credits</strong> to start building your website with AI.
            </p>

            <!-- Free Credits Box -->
            <div style="background:#f1f7ff;border:1px solid #d7e9ff;border-radius:12px;padding:20px;text-align:center;margin:20px 0;">
              <div style="font-size:30px;font-weight:900;color:#1677ff;">
                100 FREE
              </div>
              <div style="color:#555;font-size:13px;margin-top:5px;">
                Credits for your first website
              </div>
            </div>

            <p style="color:#555;font-size:14px;line-height:1.7;">
              You can also explore our <strong>free website templates</strong> and
              use them to quickly create your website.
            </p>

            <!-- Features -->
            <div style="margin:24px 0;">

              <p style="margin:12px 0;color:#333;font-size:14px;">
                ✅ <strong>100 Free Credits</strong> for new users
              </p>

              <p style="margin:12px 0;color:#333;font-size:14px;">
                ✅ <strong>Free Website Templates</strong>
              </p>

              <p style="margin:12px 0;color:#333;font-size:14px;">
                ✅ <strong>Download Your Website</strong>
              </p>

              <p style="margin:12px 0;color:#333;font-size:14px;">
                ✅ <strong>Free Hosting</strong>
              </p>

              <p style="margin:12px 0;color:#333;font-size:14px;">
                ✅ <strong>Customize Your Website</strong>
              </p>

            </div>

            <!-- CTA -->
            <a
               
              href="https://zaterwebstudio.site"
              style="display:block;background:#1677ff;color:#fff;text-decoration:none;text-align:center;padding:15px;border-radius:10px;font-size:15px;font-weight:800;margin:28px 0 20px;"
            >
              Start Building 🚀
            </a>

            <p style="color:#888;font-size:12px;line-height:1.6;text-align:center;margin:20px 0 0;">
              Your 100 free credits are available only for new users.
            </p>

          </div>

          <!-- Footer -->
          <div style="background:#f8f8fa;padding:18px;text-align:center;">
            <p style="color:#999;font-size:11px;margin:0;">
              © ${new Date().getFullYear()} Zater Web Studio
            </p>
          </div>

        </div>
      </body>
    `,
  }).catch(err => console.error('sendWelcomeEmail:', err.message));
  

export const sendUnpaidProjectEmail = ({ to, name, projectName, generatedAt }) =>
  sendBrevoEmail({
    to,
    subject: `🎉 "${projectName}" is ready — Pay ₹49 once & unlock it`,
    html: `
      <body style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f4f8;margin:0;padding:20px;">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

          <!-- Header -->
          <div style="background:#0a0a12;padding:28px 24px;text-align:center;">
            <h1 style="color:#fff;margin:0;font-size:22px;font-weight:800;">
              Zater Web Studio
            </h1>
            <p style="color:#a8a8b5;margin:8px 0 0;font-size:13px;">
              Build Your Website. Just Describe It.
            </p>
          </div>

          <!-- Content -->
          <div style="padding:32px 28px;">

            <p style="color:#555;font-size:14px;margin:0 0 12px;">
              Hi <strong>${name}</strong> 👋
            </p>

            <h2 style="color:#0a0a12;font-size:21px;margin:0 0 16px;">
              🎉 Your website is ready!
            </h2>

            <p style="color:#555;font-size:15px;line-height:1.7;">
              Your website
              <strong>"${projectName}"</strong>
              was successfully generated on
              <strong>${new Date(generatedAt).toLocaleString('en-IN')}</strong>.
            </p>

            <p style="color:#555;font-size:14px;line-height:1.7;">
              Your website is ready. Complete the
              <strong>one-time ₹49 payment</strong> to unlock your website.
            </p>

            <!-- Price Box -->
            <div style="background:#f1f7ff;border:1px solid #d7e9ff;border-radius:14px;padding:22px;text-align:center;margin:24px 0;">
              <div style="color:#1677ff;font-size:13px;font-weight:700;">
                ONE-TIME PAYMENT
              </div>

              <div style="color:#0a0a12;font-size:36px;font-weight:900;margin:5px 0;">
                ₹49
              </div>

              <div style="color:#666;font-size:13px;">
                Pay once. Enjoy the benefits for a lifetime.
              </div>
            </div>

            <!-- Benefits -->
            <h3 style="color:#0a0a12;font-size:16px;margin:24px 0 14px;">
              🔓 After your ₹49 payment, you get:
            </h3>

            <div style="color:#555;font-size:14px;line-height:1.9;">

              <p style="margin:8px 0;">
                ✅ <strong>Download your complete website</strong>
              </p>

              <p style="margin:8px 0;">
                ✅ <strong>Free hosting for a lifetime</strong>
              </p>

              <p style="margin:8px 0;">
                ✅ <strong>Free deployment</strong>
              </p>

              <p style="margin:8px 0;">
                ✅ <strong>Free code customization</strong>
              </p>

              <p style="margin:8px 0;">
                ✅ <strong>Free custom domain customization</strong>
              </p>

              <p style="margin:8px 0;">
                ✅ <strong>No recurring payment</strong>
              </p>

            </div>

            <!-- Highlight -->
            <div style="background:#f8f8fa;border-radius:12px;padding:16px;margin:24px 0;">
              <p style="color:#0a0a12;font-size:14px;line-height:1.6;margin:0;text-align:center;">
                💡 <strong>Pay ₹49 once</strong> and keep your website,
                hosting, deployment and customization access without recurring charges.
              </p>
            </div>

            <!-- CTA -->
            <a
              href="https://zaterwebstudio.site"
              style="display:block;background:#1677ff;color:#fff;text-decoration:none;text-align:center;padding:15px;border-radius:10px;font-size:15px;font-weight:800;margin:26px 0;"
            >
              🔓 Pay ₹49 &amp; Unlock My Website
            </a>

            <p style="color:#888;font-size:12px;line-height:1.6;text-align:center;margin:20px 0 0;">
              One-time payment • No recurring charges • Lifetime access to the listed benefits
            </p>

          </div>

          <!-- Footer -->
          <div style="background:#f8f8fa;padding:18px;text-align:center;">
            <p style="color:#999;font-size:11px;margin:0;">
              © ${new Date().getFullYear()} Zater Web Studio
            </p>
          </div>

        </div>
      </body>
    `,
  }).catch(err =>
    console.error('sendUnpaidProjectEmail:', err.message)
  );

export const sendZeroCreditsEmail = ({ to, name }) =>
  sendBrevoEmail({
    to,
    subject: '🚀 Your Zater credits are empty — Keep building!',
    html: `
      <body style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f4f8;margin:0;padding:20px;">
        <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

          <!-- Header -->
          <div style="background:#0a0a12;padding:28px 24px;text-align:center;">
            <h1 style="color:#fff;margin:0;font-size:22px;font-weight:800;">
              Zater Web Studio
            </h1>
            <p style="color:#a8a8b5;margin:8px 0 0;font-size:13px;">
              Build Your Website. Just Describe It.
            </p>
          </div>

          <!-- Content -->
          <div style="padding:32px 28px;">

            <p style="color:#555;font-size:14px;margin:0 0 12px;">
              Hi <strong>${name}</strong> 👋
            </p>

            <h2 style="color:#0a0a12;font-size:21px;margin:0 0 16px;">
              Your credits are empty 😯
            </h2>

            <p style="color:#555;font-size:15px;line-height:1.7;">
              You've used all your available Zater credits.
              Recharge your account and continue turning your ideas into
              real websites and applications with AI.
            </p>

            <!-- Pricing -->
            <h3 style="color:#0a0a12;font-size:16px;margin:26px 0 14px;">
              🚀 Choose your credit pack
            </h3>

            <!-- 100 Credits -->
            <div style="background:#f8f8fa;border:1px solid #e5e5eb;border-radius:14px;padding:20px;margin-bottom:14px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                  <div style="color:#0a0a12;font-size:18px;font-weight:800;">
                    100 Credits
                  </div>
                  <div style="color:#777;font-size:13px;margin-top:4px;">
                    Perfect for a website
                  </div>
                </div>

                <div style="color:#1677ff;font-size:22px;font-weight:900;">
                  ₹99
                </div>
              </div>
            </div>

            <!-- 200 Credits -->
            <div style="background:#f1f7ff;border:1px solid #cfe4ff;border-radius:14px;padding:20px;margin-bottom:20px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                  <div style="color:#0a0a12;font-size:18px;font-weight:800;">
                    200 Credits
                  </div>
                  <div style="color:#777;font-size:13px;margin-top:4px;">
                    Build bigger projects & apps
                  </div>
                </div>

                <div style="color:#1677ff;font-size:22px;font-weight:900;">
                  ₹179
                </div>
              </div>

              <div style="color:#1677ff;font-size:12px;font-weight:700;margin-top:10px;">
                ⭐ More credits for a better value
              </div>
            </div>

            <!-- Features -->
            <div style="color:#555;font-size:14px;line-height:1.9;margin:20px 0;">

              <p style="margin:8px 0;">
                ✅ Generate AI-powered websites
              </p>

              <p style="margin:8px 0;">
                ✅ Generate full-stack applications
              </p>

              <p style="margin:8px 0;">
                ✅ Customize your projects
              </p>

              <p style="margin:8px 0;">
                ✅ Turn your ideas into real products
              </p>

            </div>

            <!-- CTA -->
            <a
              href="https://zaterwebstudio.site/credits"
              style="display:block;background:#1677ff;color:#fff;text-decoration:none;text-align:center;padding:15px;border-radius:10px;font-size:15px;font-weight:800;margin:28px 0 20px;"
            >
              💳 Buy Credits &amp; Keep Building
            </a>

            <p style="color:#999;font-size:12px;line-height:1.6;text-align:center;margin:20px 0 0;">
              Choose the credit pack that fits your next project. 🚀
            </p>

          </div>

          <!-- Footer -->
          <div style="background:#f8f8fa;padding:18px;text-align:center;">
            <p style="color:#999;font-size:11px;margin:0;">
              © ${new Date().getFullYear()} Zater Web Studio
            </p>
          </div>

        </div>
      </body>
    `,
  }).catch(err =>
    console.error('sendZeroCreditsEmail:', err.message)
  );