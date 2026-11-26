const EmailApiAccount = require('../models/EmailApiAccount');
const {
  normalizeApiKey,
  validateBrevoApiKey,
  classifyBrevoKey,
} = require('../services/brevoClient');

function attachKeyMeta(accountDoc) {
  const obj = accountDoc.toObject ? accountDoc.toObject() : accountDoc;
  return {
    ...obj,
    keyType: classifyBrevoKey(obj.apiKey),
  };
}

exports.getAll = async (req, res) => {
  try {
    const accounts = await EmailApiAccount.find().sort({ createdAt: -1 });
    res.json({
      success: true,
      count: accounts.length,
      data: accounts.map(attachKeyMeta),
    });
  } catch (error) {
    console.error('Error fetching email API accounts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch email API accounts',
      error: error.message,
    });
  }
};

exports.getById = async (req, res) => {
  try {
    const account = await EmailApiAccount.findById(req.params.id);

    if (!account) {
      return res.status(404).json({
        success: false,
        message: 'Email API account not found',
      });
    }

    res.json({
      success: true,
      data: attachKeyMeta(account),
    });
  } catch (error) {
    console.error('Error fetching email API account:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch email API account',
      error: error.message,
    });
  }
};

exports.create = async (req, res) => {
  try {
    const { name, provider = 'brevo', apiKey } = req.body;
    const cleanKey = normalizeApiKey(apiKey);

    if (!name || !cleanKey) {
      return res.status(400).json({
        success: false,
        message: 'Name and API key are required',
      });
    }

    const keyCheck = await validateBrevoApiKey(cleanKey);
    if (!keyCheck.ok) {
      return res.status(400).json({
        success: false,
        message: keyCheck.message,
      });
    }

    const existingAccount = await EmailApiAccount.findOne({ name });
    if (existingAccount) {
      return res.status(400).json({
        success: false,
        message: 'An account with this name already exists',
      });
    }

    const account = new EmailApiAccount({
      name,
      provider,
      apiKey: cleanKey,
    });

    await account.save();

    res.status(201).json({
      success: true,
      message: `Email API account created (Brevo: ${keyCheck.accountEmail || 'OK'})`,
      data: attachKeyMeta(account),
    });
  } catch (error) {
    console.error('Error creating email API account:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create email API account',
      error: error.message,
    });
  }
};

exports.update = async (req, res) => {
  try {
    const { name, provider, apiKey } = req.body;

    const account = await EmailApiAccount.findById(req.params.id);
    if (!account) {
      return res.status(404).json({
        success: false,
        message: 'Email API account not found',
      });
    }

    if (name && name !== account.name) {
      const existingAccount = await EmailApiAccount.findOne({
        name,
        _id: { $ne: req.params.id },
      });
      if (existingAccount) {
        return res.status(400).json({
          success: false,
          message: 'An account with this name already exists',
        });
      }
    }

    if (name) account.name = name;
    if (provider) account.provider = provider;
    if (apiKey) {
      const cleanKey = normalizeApiKey(apiKey);
      const keyCheck = await validateBrevoApiKey(cleanKey);
      if (!keyCheck.ok) {
        return res.status(400).json({
          success: false,
          message: keyCheck.message,
        });
      }
      account.apiKey = cleanKey;
    }

    await account.save();

    res.json({
      success: true,
      message: 'Email API account updated successfully',
      data: attachKeyMeta(account),
    });
  } catch (error) {
    console.error('Error updating email API account:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update email API account',
      error: error.message,
    });
  }
};

exports.test = async (req, res) => {
  try {
    const account = await EmailApiAccount.findById(req.params.id);
    if (!account) {
      return res.status(404).json({
        success: false,
        message: 'Email API account not found',
      });
    }

    const keyCheck = await validateBrevoApiKey(account.apiKey);
    if (!keyCheck.ok) {
      return res.status(400).json({
        success: false,
        message: keyCheck.message,
        keyType: classifyBrevoKey(account.apiKey),
      });
    }

    return res.json({
      success: true,
      message: 'API key is valid',
      brevoAccountEmail: keyCheck.accountEmail,
      plan: keyCheck.plan,
      accountName: account.name,
      keyType: 'api',
    });
  } catch (error) {
    console.error('Error testing email API account:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to test email API account',
      error: error.message,
    });
  }
};

exports.delete = async (req, res) => {
  try {
    const account = await EmailApiAccount.findById(req.params.id);

    if (!account) {
      return res.status(404).json({
        success: false,
        message: 'Email API account not found',
      });
    }

    await EmailApiAccount.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Email API account deleted successfully',
      data: account,
    });
  } catch (error) {
    console.error('Error deleting email API account:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete email API account',
      error: error.message,
    });
  }
};