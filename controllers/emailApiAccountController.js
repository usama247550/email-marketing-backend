const EmailApiAccount = require('../models/EmailApiAccount');

// Get all email API accounts
exports.getAll = async (req, res) => {
  try {
    const accounts = await EmailApiAccount.find().sort({ createdAt: -1 });
    res.json({
      success: true,
      count: accounts.length,
      data: accounts
    });
  } catch (error) {
    console.error('Error fetching email API accounts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch email API accounts',
      error: error.message
    });
  }
};

// Get email API account by ID
exports.getById = async (req, res) => {
  try {
    const account = await EmailApiAccount.findById(req.params.id);
    
    if (!account) {
      return res.status(404).json({
        success: false,
        message: 'Email API account not found'
      });
    }

    res.json({
      success: true,
      data: account
    });
  } catch (error) {
    console.error('Error fetching email API account:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch email API account',
      error: error.message
    });
  }
};

// Create new email API account
exports.create = async (req, res) => {
  try {
    const { name, provider = 'brevo', apiKey } = req.body;

    // Validate required fields
    if (!name || !apiKey) {
      return res.status(400).json({
        success: false,
        message: 'Name and API key are required'
      });
    }

    // Check if account name already exists
    const existingAccount = await EmailApiAccount.findOne({ name });
    if (existingAccount) {
      return res.status(400).json({
        success: false,
        message: 'An account with this name already exists'
      });
    }

    const account = new EmailApiAccount({
      name,
      provider,
      apiKey
    });

    await account.save();

    res.status(201).json({
      success: true,
      message: 'Email API account created successfully',
      data: account
    });
  } catch (error) {
    console.error('Error creating email API account:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create email API account',
      error: error.message
    });
  }
};

// Update email API account
exports.update = async (req, res) => {
  try {
    const { name, provider, apiKey } = req.body;
    
    const account = await EmailApiAccount.findById(req.params.id);
    if (!account) {
      return res.status(404).json({
        success: false,
        message: 'Email API account not found'
      });
    }

    // Check if new name conflicts with another account (excluding current one)
    if (name && name !== account.name) {
      const existingAccount = await EmailApiAccount.findOne({ 
        name, 
        _id: { $ne: req.params.id } 
      });
      if (existingAccount) {
        return res.status(400).json({
          success: false,
          message: 'An account with this name already exists'
        });
      }
    }

    // Update fields
    if (name) account.name = name;
    if (provider) account.provider = provider;
    if (apiKey) account.apiKey = apiKey;

    await account.save();

    res.json({
      success: true,
      message: 'Email API account updated successfully',
      data: account
    });
  } catch (error) {
    console.error('Error updating email API account:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update email API account',
      error: error.message
    });
  }
};

// Delete email API account
exports.delete = async (req, res) => {
  try {
    const account = await EmailApiAccount.findById(req.params.id);
    
    if (!account) {
      return res.status(404).json({
        success: false,
        message: 'Email API account not found'
      });
    }

    await EmailApiAccount.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Email API account deleted successfully',
      data: account
    });
  } catch (error) {
    console.error('Error deleting email API account:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete email API account',
      error: error.message
    });
  }
};