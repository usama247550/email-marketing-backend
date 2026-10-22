/**
 * backend/tests/brevoEventsPoller.test.js
 *
 * Mock test for the Brevo events poller. Uses a test database and stubs HTTP calls.
 * Tests:
 * (a) An open event marks matching EmailLog "opened" and increments campaignOpenedCount once
 * (b) Running poller again with same events changes nothing (idempotent)
 * (c) Pagination over multiple pages works
 * (d) Event with no matching log is counted as unmatched and doesn't crash
 * (e) Invalid API key is logged and next account still processed
 * (f) Log already marked "unsubscribed" is not overwritten by open event
 *
 * REQUIRES: MongoDB running on localhost:27017
 */

require('dotenv').config();

const mongoose = require('mongoose');
const axios = require('axios');
const { expect } = require('chai');
const sinon = require('sinon');

// Import poller
const { pollBrevoOpens } = require('../services/brevoEventsPoller');

// Import models
const EmailLog = require('../models/EmailLog');
const Campaign = require('../models/Campaign');
const Project = require('../models/Project');
const EmailApiAccount = require('../models/EmailApiAccount');

// Test database
const TEST_DB_NAME = `test_brevo_poller_${Date.now()}`;
const TEST_MONGODB_URI = `mongodb://localhost:27017/${TEST_DB_NAME}`;

describe('Brevo Events Poller', function () {
  this.timeout(10000); // Allow 10s for tests

  before(async () => {
    // Connect to test database
    try {
      await mongoose.connect(TEST_MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
      console.log(`\n  Connected to test DB: ${TEST_DB_NAME}`);
    } catch (err) {
      console.error('\n  ERROR: Failed to connect to test DB:', err.message);
      console.error('  Make sure MongoDB is running on localhost:27017');
      process.exit(1);
    }
  });

  after(async () => {
    // Clean up test database
    try {
      if (mongoose.connection.db) {
        await mongoose.connection.dropDatabase();
        console.log(`  Dropped test DB: ${TEST_DB_NAME}`);
      }
      await mongoose.disconnect();
    } catch (err) {
      console.error('  Cleanup error:', err.message);
    }
  });

  beforeEach(async () => {
    // Clear collections before each test
    await EmailLog.deleteMany({});
    await Campaign.deleteMany({});
    await Project.deleteMany({});
    await EmailApiAccount.deleteMany({});
  });

  // Test (a): Open event marks log "opened" and increments count once
  it('(a) marks matching log as opened and increments campaign count', async () => {
    // Create account
    const account = await EmailApiAccount.create({
      name: 'Test Account',
      provider: 'brevo',
      apiKey: 'valid_key_123'
    });

    // Create project
    const project = await Project.create({
      name: 'Test Project',
      senderEmail: 'sender@test.com',
      emailApiAccountId: account._id,
      sendingMethod: 'brevo_api'
    });

    // Create campaign
    const campaign = await Campaign.create({
      name: 'Test Campaign',
      projectId: project._id,
      templateId: new mongoose.Types.ObjectId(),
      totalRecipients: 1,
      sentCount: 1,
      openedCount: 0
    });

    // Create email log with brevoMessageId
    const emailLog = await EmailLog.create({
      campaignId: campaign._id,
      leadId: new mongoose.Types.ObjectId(),
      email: 'test@example.com',
      status: 'sent',
      trackingId: 'test_tracking_id_001',
      brevoMessageId: '<msg_id_001>',
      sentAt: new Date(Date.now() - 1000 * 60 * 60) // 1 hour ago
    });

    // Stub axios to return mock events
    const axiosStub = sinon.stub(axios, 'get');
    axiosStub.resolves({
      data: {
        events: [
          {
            'message-id': 'msg_id_001',
            email: 'test@example.com',
            event: 'opened',
            date: new Date().toISOString(),
            tags: ['tid_test_tracking_id_001']
          }
        ]
      }
    });

    // Run poller
    const result = await pollBrevoOpens({ daysNormal: 2 });

    // Verify results
    expect(result.eventsFetched).to.equal(1);
    expect(result.matched).to.equal(1);
    expect(result.updated).to.equal(1);
    expect(result.unmatched).to.equal(0);

    // Verify EmailLog status changed
    const updatedLog = await EmailLog.findById(emailLog._id);
    expect(updatedLog.status).to.equal('opened');
    expect(updatedLog.openedAt).to.exist;

    // Verify Campaign openedCount incremented
    const updatedCampaign = await Campaign.findById(campaign._id);
    expect(updatedCampaign.openedCount).to.equal(1);

    axiosStub.restore();
  });

  // Test (b): Running poller again with same events is idempotent
  it('(b) is idempotent - running twice with same events changes nothing', async () => {
    // Setup same as test (a)
    const account = await EmailApiAccount.create({
      name: 'Test Account',
      provider: 'brevo',
      apiKey: 'valid_key_123'
    });

    const project = await Project.create({
      name: 'Test Project',
      senderEmail: 'sender@test.com',
      emailApiAccountId: account._id
    });

    const campaign = await Campaign.create({
      name: 'Test Campaign',
      projectId: project._id,
      templateId: new mongoose.Types.ObjectId(),
      totalRecipients: 1,
      sentCount: 1,
      openedCount: 0
    });

    const emailLog = await EmailLog.create({
      campaignId: campaign._id,
      leadId: new mongoose.Types.ObjectId(),
      email: 'test@example.com',
      status: 'sent',
      trackingId: 'test_tracking_id_002',
      brevoMessageId: '<msg_id_002>',
      sentAt: new Date(Date.now() - 1000 * 60 * 60)
    });

    const axiosStub = sinon.stub(axios, 'get');
    const mockEvent = {
      'message-id': 'msg_id_002',
      email: 'test@example.com',
      event: 'opened',
      date: new Date().toISOString(),
      tags: ['tid_test_tracking_id_002']
    };

    axiosStub.resolves({
      data: { events: [mockEvent] }
    });

    // First run
    const result1 = await pollBrevoOpens({ daysNormal: 2 });
    expect(result1.updated).to.equal(1);

    let campaign1 = await Campaign.findById(campaign._id);
    expect(campaign1.openedCount).to.equal(1);

    // Second run with same data
    const result2 = await pollBrevoOpens({ daysNormal: 2 });
    expect(result2.updated).to.equal(0); // No update on second run

    let campaign2 = await Campaign.findById(campaign._id);
    expect(campaign2.openedCount).to.equal(1); // Still 1, not 2

    axiosStub.restore();
  });

  // Test (c): Pagination works over multiple pages
  it('(c) handles pagination over multiple pages', async () => {
    const account = await EmailApiAccount.create({
      name: 'Test Account',
      provider: 'brevo',
      apiKey: 'valid_key_123'
    });

    const project = await Project.create({
      name: 'Test Project',
      senderEmail: 'sender@test.com',
      emailApiAccountId: account._id
    });

    const campaign = await Campaign.create({
      name: 'Test Campaign',
      projectId: project._id,
      templateId: new mongoose.Types.ObjectId(),
      totalRecipients: 3,
      sentCount: 3,
      openedCount: 0
    });

    // Create 3 logs
    const logs = [];
    for (let i = 0; i < 3; i++) {
      const log = await EmailLog.create({
        campaignId: campaign._id,
        leadId: new mongoose.Types.ObjectId(),
        email: `test${i}@example.com`,
        status: 'sent',
        trackingId: `tracking_${i}`,
        brevoMessageId: `msg_${i}`,
        sentAt: new Date(Date.now() - 1000 * 60 * 60)
      });
      logs.push(log);
    }

    const axiosStub = sinon.stub(axios, 'get');

    // Mock two pages of results
    const page1Events = [
      { 'message-id': 'msg_0', email: 'test0@example.com', event: 'opened', date: new Date().toISOString(), tags: [] },
      { 'message-id': 'msg_1', email: 'test1@example.com', event: 'opened', date: new Date().toISOString(), tags: [] }
    ];

    const page2Events = [
      { 'message-id': 'msg_2', email: 'test2@example.com', event: 'opened', date: new Date().toISOString(), tags: [] }
    ];

    let callCount = 0;
    axiosStub.callsFake(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ data: { events: page1Events } });
      } else {
        return Promise.resolve({ data: { events: page2Events } });
      }
    });

    const result = await pollBrevoOpens({ daysNormal: 2 });

    expect(result.eventsFetched).to.equal(3);
    expect(result.matched).to.equal(3);
    expect(result.updated).to.equal(3);

    const updatedCampaign = await Campaign.findById(campaign._id);
    expect(updatedCampaign.openedCount).to.equal(3);

    axiosStub.restore();
  });

  // Test (d): Unmatched event doesn't crash
  it('(d) counts unmatched events and does not crash', async () => {
    const account = await EmailApiAccount.create({
      name: 'Test Account',
      provider: 'brevo',
      apiKey: 'valid_key_123'
    });

    const project = await Project.create({
      name: 'Test Project',
      senderEmail: 'sender@test.com',
      emailApiAccountId: account._id
    });

    const campaign = await Campaign.create({
      name: 'Test Campaign',
      projectId: project._id,
      templateId: new mongoose.Types.ObjectId()
    });

    const axiosStub = sinon.stub(axios, 'get');
    axiosStub.resolves({
      data: {
        events: [
          {
            'message-id': 'unknown_msg_id',
            email: 'unknown@example.com',
            event: 'opened',
            date: new Date().toISOString(),
            tags: []
          }
        ]
      }
    });

    const result = await pollBrevoOpens({ daysNormal: 2 });

    expect(result.eventsFetched).to.equal(1);
    expect(result.matched).to.equal(0);
    expect(result.unmatched).to.equal(1);
    expect(result.updated).to.equal(0);

    axiosStub.restore();
  });

  // Test (e): Invalid API key is logged, next account processed
  it('(e) logs invalid API key error and continues with next account', async () => {
    // Create two accounts
    const account1 = await EmailApiAccount.create({
      name: 'Bad Account',
      provider: 'brevo',
      apiKey: 'invalid_key'
    });

    const account2 = await EmailApiAccount.create({
      name: 'Good Account',
      provider: 'brevo',
      apiKey: 'valid_key_456'
    });

    // Create projects
    const project1 = await Project.create({
      name: 'Project 1',
      senderEmail: 'sender1@test.com',
      emailApiAccountId: account1._id
    });

    const project2 = await Project.create({
      name: 'Project 2',
      senderEmail: 'sender2@test.com',
      emailApiAccountId: account2._id
    });

    // Create campaigns
    const campaign1 = await Campaign.create({
      name: 'Campaign 1',
      projectId: project1._id,
      templateId: new mongoose.Types.ObjectId(),
      sentCount: 1
    });

    const campaign2 = await Campaign.create({
      name: 'Campaign 2',
      projectId: project2._id,
      templateId: new mongoose.Types.ObjectId(),
      sentCount: 1
    });

    // Create email logs
    const log1 = await EmailLog.create({
      campaignId: campaign1._id,
      leadId: new mongoose.Types.ObjectId(),
      email: 'test1@example.com',
      status: 'sent',
      trackingId: 'tracking_account1',
      brevoMessageId: 'msg_account1',
      sentAt: new Date(Date.now() - 1000 * 60 * 60)
    });

    const log2 = await EmailLog.create({
      campaignId: campaign2._id,
      leadId: new mongoose.Types.ObjectId(),
      email: 'test2@example.com',
      status: 'sent',
      trackingId: 'tracking_account2',
      brevoMessageId: 'msg_account2',
      sentAt: new Date(Date.now() - 1000 * 60 * 60)
    });

    const axiosStub = sinon.stub(axios, 'get');
    axiosStub.callsFake((url, config) => {
      if (config.headers['api-key'] === 'invalid_key') {
        return Promise.reject({
          response: { status: 401, data: { message: 'Unauthorized' } },
          message: 'Unauthorized'
        });
      }
      return Promise.resolve({
        data: {
          events: [
            {
              'message-id': 'msg_account2',
              email: 'test2@example.com',
              event: 'opened',
              date: new Date().toISOString(),
              tags: []
            }
          ]
        }
      });
    });

    const result = await pollBrevoOpens({ daysNormal: 2 });

    // Account1 had error, but account2 was still processed
    expect(result.errors).to.equal(1);
    expect(result.accountsChecked).to.equal(2);
    expect(result.eventsFetched).to.equal(1);
    expect(result.matched).to.equal(1);
    expect(result.updated).to.equal(1);

    const updatedLog2 = await EmailLog.findById(log2._id);
    expect(updatedLog2.status).to.equal('opened');

    axiosStub.restore();
  });

  // Test (f): Log already "unsubscribed" is not overwritten
  it('(f) does not overwrite unsubscribed status with opened', async () => {
    const account = await EmailApiAccount.create({
      name: 'Test Account',
      provider: 'brevo',
      apiKey: 'valid_key_123'
    });

    const project = await Project.create({
      name: 'Test Project',
      senderEmail: 'sender@test.com',
      emailApiAccountId: account._id
    });

    const campaign = await Campaign.create({
      name: 'Test Campaign',
      projectId: project._id,
      templateId: new mongoose.Types.ObjectId(),
      sentCount: 1,
      unsubscribedCount: 1
    });

    // Create log that's already unsubscribed
    const emailLog = await EmailLog.create({
      campaignId: campaign._id,
      leadId: new mongoose.Types.ObjectId(),
      email: 'test@example.com',
      status: 'unsubscribed',
      trackingId: 'test_tracking_id_003',
      brevoMessageId: '<msg_id_003>',
      sentAt: new Date(Date.now() - 1000 * 60 * 60),
      unsubscribedAt: new Date(Date.now() - 1000 * 60 * 30)
    });

    const axiosStub = sinon.stub(axios, 'get');
    axiosStub.resolves({
      data: {
        events: [
          {
            'message-id': 'msg_id_003',
            email: 'test@example.com',
            event: 'opened',
            date: new Date().toISOString(),
            tags: []
          }
        ]
      }
    });

    const result = await pollBrevoOpens({ daysNormal: 2 });

    expect(result.eventsFetched).to.equal(1);
    expect(result.matched).to.equal(1);
    expect(result.updated).to.equal(0); // Not updated (status protection)

    const unchangedLog = await EmailLog.findById(emailLog._id);
    expect(unchangedLog.status).to.equal('unsubscribed'); // Still unsubscribed
    expect(unchangedLog.openedAt).to.not.exist; // openedAt not set

    const unchangedCampaign = await Campaign.findById(campaign._id);
    expect(unchangedCampaign.openedCount).to.equal(0); // openedCount not incremented

    axiosStub.restore();
  });
});
