'use strict';

const fs = require('fs/promises');
const request = require('supertest');
const { expect } = require('chai');
const sinon = require('sinon');

const app = require('../app');
const eventArchiveRequestStore = require('../services/eventArchiveRequestStore');
const eventFileStore = require('../services/eventFileStore');
const eventStore = require('../services/eventStore');
const mailService = require('../services/mailService');
const settingsStore = require('../services/settingsStore');
const userStore = require('../services/userStore');

const EVENT_STORAGE_ROOT = eventStore.getEventStorageRoot();

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!match) {
    throw new Error('Token CSRF introuvable dans la page');
  }

  return match[1];
}

function extractSetCookie(response, cookieName) {
  const setCookieHeaders = response.headers['set-cookie'] || [];
  return setCookieHeaders.find((entry) => entry.startsWith(`${cookieName}=`));
}

async function loginAsDefaultAdmin(agent) {
  const loginPage = await agent.get('/login');

  const loginResponse = await agent
    .post('/login')
    .type('form')
    .send({
      _csrf: extractCsrfToken(loginPage.text),
      email: 'admin@example.com',
      password: 'Admin1234',
    });

  expect(loginResponse.status).to.equal(302);
}

async function registerGuestForEvent(agent, token, guestName) {
  const registerPage = await agent.get(`/event/${token}/register`);

  const registerResponse = await agent
    .post(`/event/${token}/register`)
    .type('form')
    .send({
      _csrf: extractCsrfToken(registerPage.text),
      guestName,
    });

  expect(registerResponse.status).to.equal(302);
}

async function waitForArchive(eventId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const eventItem = await eventStore.findById(eventId);
    if (eventItem && eventItem.archiveStatus !== 'pending') {
      return eventItem;
    }

    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }

  throw new Error('Timeout: archive toujours en attente');
}

describe('Demande d\'archive par email sur la page evenement', () => {
  let owner;

  beforeEach(async () => {
    userStore.resetTestState();
    eventFileStore.resetTestState();
    eventStore.resetTestState();
    eventArchiveRequestStore.resetTestState();
    settingsStore.resetTestState();

    await fs.rm(EVENT_STORAGE_ROOT, { recursive: true, force: true });
    await fs.mkdir(EVENT_STORAGE_ROOT, { recursive: true });

    owner = await userStore.findByEmail('admin@example.com');
  });

  afterEach(() => {
    sinon.restore();
    delete process.env.SMTP_HOST;
  });

  async function createActiveEvent(name = 'Soiree avec archive par email') {
    return eventStore.createEvent({
      ownerUserId: owner.id,
      name,
      description: 'Un evenement utilise pour tester la demande d\'archive.',
      startsAt: '2099-06-01T19:00:00',
      status: 'active',
    });
  }

  it('enregistre la demande en base et pose un cookie quand l\'invite coche la case', async () => {
    const createdEvent = await createActiveEvent();

    const guestAgent = request.agent(app);
    await registerGuestForEvent(guestAgent, createdEvent.token, 'Visiteur Archive');

    const eventPage = await guestAgent.get(`/event/${createdEvent.token}`);

    const response = await guestAgent
      .post(`/event/${createdEvent.token}/archive-request`)
      .type('form')
      .send({
        _csrf: extractCsrfToken(eventPage.text),
        wantsArchive: '1',
        email: 'invite@example.com',
      });

    expect(response.status).to.equal(302);
    expect(response.headers.location).to.equal(`/event/${createdEvent.token}`);

    const cookieHeader = extractSetCookie(response, `event_archive_request_${createdEvent.token}`);
    expect(cookieHeader).to.include('invite%40example.com');

    const requests = await eventArchiveRequestStore.listByEvent(createdEvent.id);
    expect(requests).to.have.lengthOf(1);
    expect(requests[0].email).to.equal('invite@example.com');

    const eventPageAfter = await guestAgent.get(`/event/${createdEvent.token}`);
    expect(eventPageAfter.text).to.include('value="invite@example.com"');
  });

  it('supprime la demande et le cookie quand l\'invite decoche la case', async () => {
    const createdEvent = await createActiveEvent();

    const guestAgent = request.agent(app);
    await registerGuestForEvent(guestAgent, createdEvent.token, 'Visiteur Archive');

    const eventPage = await guestAgent.get(`/event/${createdEvent.token}`);
    await guestAgent
      .post(`/event/${createdEvent.token}/archive-request`)
      .type('form')
      .send({
        _csrf: extractCsrfToken(eventPage.text),
        wantsArchive: '1',
        email: 'invite@example.com',
      });

    expect(await eventArchiveRequestStore.listByEvent(createdEvent.id)).to.have.lengthOf(1);

    const eventPageAfterOptIn = await guestAgent.get(`/event/${createdEvent.token}`);
    const optOutResponse = await guestAgent
      .post(`/event/${createdEvent.token}/archive-request`)
      .type('form')
      .send({
        _csrf: extractCsrfToken(eventPageAfterOptIn.text),
      });

    expect(optOutResponse.status).to.equal(302);
    expect(await eventArchiveRequestStore.listByEvent(createdEvent.id)).to.have.lengthOf(0);

    const clearedCookie = extractSetCookie(optOutResponse, `event_archive_request_${createdEvent.token}`);
    expect(clearedCookie).to.exist;
    expect(clearedCookie).to.match(/event_archive_request_.*=;/);
  });

  it('notifie par email les inscrits une fois l\'archive prete, si l\'envoi est active et SMTP configure', async () => {
    process.env.SMTP_HOST = 'smtp.test.local';
    const sendMailStub = sinon.stub(mailService, 'sendMail').resolves();

    const createdEvent = await createActiveEvent('Soiree avec notification');

    const guestAgent = request.agent(app);
    await registerGuestForEvent(guestAgent, createdEvent.token, 'Visiteur Notifie');

    const eventPage = await guestAgent.get(`/event/${createdEvent.token}`);
    await guestAgent
      .post(`/event/${createdEvent.token}/archive-request`)
      .type('form')
      .send({
        _csrf: extractCsrfToken(eventPage.text),
        wantsArchive: '1',
        email: 'notification@example.com',
      });

    await settingsStore.setBoolSetting('mail_archive_notifications_enabled', true);

    const ownerAgent = request.agent(app);
    await loginAsDefaultAdmin(ownerAgent);

    const profilePage = await ownerAgent.get('/profile');
    await ownerAgent
      .post(`/profile/events/${createdEvent.id}/close`)
      .type('form')
      .send({
        _csrf: extractCsrfToken(profilePage.text),
        confirmClose: 'CLOTURER',
      });

    await waitForArchive(createdEvent.id);
    // La notification est declenchee juste apres la mise a jour d'etat, mais reste asynchrone.
    await new Promise((resolve) => { setTimeout(resolve, 100); });

    expect(sendMailStub.calledOnce).to.equal(true);
    const mailArgs = sendMailStub.firstCall.args[0];
    expect(mailArgs.to).to.equal('notification@example.com');
    expect(mailArgs.text).to.include(`/event/${createdEvent.token}/archive`);
  });

  it('n\'envoie aucun mail si la notification n\'est pas activee dans les reglages', async () => {
    process.env.SMTP_HOST = 'smtp.test.local';
    const sendMailStub = sinon.stub(mailService, 'sendMail').resolves();

    const createdEvent = await createActiveEvent('Soiree sans notification activee');

    const guestAgent = request.agent(app);
    await registerGuestForEvent(guestAgent, createdEvent.token, 'Visiteur Silencieux');

    const eventPage = await guestAgent.get(`/event/${createdEvent.token}`);
    await guestAgent
      .post(`/event/${createdEvent.token}/archive-request`)
      .type('form')
      .send({
        _csrf: extractCsrfToken(eventPage.text),
        wantsArchive: '1',
        email: 'silencieux@example.com',
      });

    // mail_archive_notifications_enabled reste a false (valeur par defaut).

    const ownerAgent = request.agent(app);
    await loginAsDefaultAdmin(ownerAgent);

    const profilePage = await ownerAgent.get('/profile');
    await ownerAgent
      .post(`/profile/events/${createdEvent.id}/close`)
      .type('form')
      .send({
        _csrf: extractCsrfToken(profilePage.text),
        confirmClose: 'CLOTURER',
      });

    await waitForArchive(createdEvent.id);
    await new Promise((resolve) => { setTimeout(resolve, 100); });

    expect(sendMailStub.called).to.equal(false);
  });
});
