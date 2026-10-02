const EmailLog = require('../models/EmailLog');
const Campaign = require('../models/Campaign');
const Lead = require('../models/Lead');

// Track email open - returns a 1x1 transparent GIF
exports.trackOpen = async (req, res) => {
  try {
    const { trackingId } = req.params;

    // Find the email log by tracking ID
    const emailLog = await EmailLog.findOne({ trackingId });

    if (!emailLog) {
      console.log(`Open tracking: Token not found: ${trackingId}`);
      return sendTrackingPixel(res);
    }

    // Only update if status is currently "sent" (prevent double-counting)
    if (emailLog.status === 'sent') {
      // Update email log to "opened"
      emailLog.status = 'opened';
      emailLog.openedAt = new Date();
      await emailLog.save();

      // Increment campaign's opened count
      await Campaign.findByIdAndUpdate(
        emailLog.campaignId,
        { $inc: { openedCount: 1 } }
      );

      console.log(`Email opened: ${emailLog.email} (Campaign: ${emailLog.campaignId})`);
    } else {
      console.log(`Email already tracked as ${emailLog.status}: ${emailLog.email}`);
    }

    // Always return tracking pixel regardless of update success
    return sendTrackingPixel(res);

  } catch (error) {
    console.error('Open tracking error:', error);
    // Still return tracking pixel even on error to avoid broken images
    return sendTrackingPixel(res);
  }
};

// Track unsubscribe - returns HTML page
exports.trackUnsubscribe = async (req, res) => {
  try {
    const { trackingId } = req.params;

    // Find the email log by tracking ID
    const emailLog = await EmailLog.findOne({ trackingId }).populate('leadId');

    if (!emailLog) {
      return res.status(404).send(`
        <html>
          <head><title>Unsubscribe</title></head>
          <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
            <h2>Link Not Found</h2>
            <p>This unsubscribe link is not valid or has expired.</p>
          </body>
        </html>
      `);
    }

    // Update email log status
    const wasAlreadyUnsubscribed = emailLog.status === 'unsubscribed';
    emailLog.status = 'unsubscribed';
    emailLog.unsubscribedAt = new Date();
    await emailLog.save();

    // Update the lead's status to "Unsubscribed" (prevents future campaigns)
    if (emailLog.leadId) {
      emailLog.leadId.status = 'Unsubscribed';
      await emailLog.leadId.save();
      console.log(`Lead unsubscribed: ${emailLog.leadId.email} (ID: ${emailLog.leadId._id})`);
    }

    // Increment campaign's unsubscribed count (only if not already unsubscribed)
    if (!wasAlreadyUnsubscribed) {
      await Campaign.findByIdAndUpdate(
        emailLog.campaignId,
        { $inc: { unsubscribedCount: 1 } }
      );
      console.log(`Campaign unsubscribe count incremented for campaign: ${emailLog.campaignId}`);
    }

    // Return success page
    res.send(`
      <html>
        <head>
          <title>Unsubscribed Successfully</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              padding: 40px;
              text-align: center;
              background-color: #f9f9f9;
            }
            .container {
              max-width: 500px;
              margin: 0 auto;
              background: white;
              padding: 30px;
              border-radius: 8px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .success-icon {
              color: #4CAF50;
              font-size: 48px;
              margin-bottom: 20px;
            }
            h2 { color: #333; }
            p { color: #666; line-height: 1.6; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success-icon">✓</div>
            <h2>You have been unsubscribed successfully</h2>
            <p>You will no longer receive emails from this sender.</p>
            <p><small>If you unsubscribed by mistake, please contact the sender directly to re-subscribe.</small></p>
          </div>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('Unsubscribe tracking error:', error);
    res.status(500).send(`
      <html>
        <head><title>Unsubscribe Error</title></head>
        <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
          <h2>Error Processing Unsubscribe</h2>
          <p>There was an error processing your unsubscribe request. Please try again later.</p>
        </body>
      </html>
    `);
  }
};

// Helper function to send 1x1 transparent GIF tracking pixel
function sendTrackingPixel(res) {
  // 1x1 transparent GIF in base64
  const transparentGif = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );

  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': transparentGif.length,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });

  res.end(transparentGif);
}