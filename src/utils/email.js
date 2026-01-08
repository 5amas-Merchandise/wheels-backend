const nodemailer = require('nodemailer');

const sendOTP = async (userEmail, otp) => {
  console.log(`[sendOTP] Starting for email: ${userEmail}, OTP: ${otp}`);
  
  const emailUser = process.env.EMAIL_USER || "nonreply.wheela@gmail.com";
  const emailPass = process.env.EMAIL_PASS || "";

  console.log(`[sendOTP] Using email: ${emailUser}`);

  if (!emailUser || !emailPass) {
    const errMsg = "Email credentials not configured properly";
    console.error(`[sendOTP] ${errMsg}`);
    throw new Error(errMsg);
  }

  // Create transporter
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: emailUser,
      pass: emailPass,
    },
  });

  const mailOptions = {
    from: `"Wheela" <${emailUser}>`,
    to: userEmail,
    subject: "Your Wheela OTP Code",
    text: `Your OTP code is: ${otp}. This code will expire in 10 minutes. Do not share this code with anyone.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a365d;">Wheela Verification</h2>
        <p>Your One-Time Password (OTP) is:</p>
        <div style="background: #f8f9fa; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 5px; color: #1a365d; margin: 20px 0;">
          ${otp}
        </div>
        <p>This OTP will expire in <strong>10 minutes</strong>.</p>
        <p style="color: #666; font-size: 14px;">
          <strong>Security Tip:</strong> Never share this code with anyone. Wheela will never ask for your OTP.
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="color: #999; font-size: 12px;">
          If you didn't request this OTP, please ignore this email or contact support immediately.
        </p>
      </div>
    `,
  };

  try {
    console.log(`[sendOTP] Sending email to: ${userEmail}`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`[sendOTP] Email sent successfully: Message ID ${info.messageId}`);
    return true;
  } catch (sendError) {
    console.error(`[sendOTP] Email send failed:`, sendError && sendError.message ? sendError.message : sendError);
    throw new Error(`Failed to send email: ${sendError && sendError.message ? sendError.message : sendError}`);
  }
};

module.exports = { sendOTP };