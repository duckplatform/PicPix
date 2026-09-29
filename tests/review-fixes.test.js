'use strict';

/**
 * Tests de non-regression des correctifs issus de la revue de code
 * (securite des uploads, XSS slideshow, cookie d'archive, cloture, admin...).
 */

const fs = require('fs/promises');
const path = require('path');
const request = require('supertest');
const { expect } = require('chai');
const sinon = require('sinon');

const app = require('../app');
const timezone = require('../config/timezone');
const archiveNotificationService = require('../services/archiveNotificationService');
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

async function login(agent, email = 'admin@example.com', password = 'Admin1234') {
  const loginPage = await agent.get('/login');
  const loginResponse = await agent
    .post('/login')
    .type('form')
    .send({ _csrf: extractCsrfToken(loginPage.text), email, password });

  expect(loginResponse.status).to.equal(302);
  return loginResponse;
}

async function registerGuestForEvent(agent, token, guestName) {
  const registerPage = await agent.get(`/event/${token}/register`);
  const registerResponse = await agent
    .post(`/event/${token}/register`)
    .type('form')
    .send({ _csrf: extractCsrfToken(registerPage.text), guestName });

  expect(registerResponse.status).to.equal(302);
}

async function uploadAs(guestAgent, createdEvent, filename, contentType) {
  const uploadPage = await guestAgent.get(`/event/${createdEvent.token}/upload`);
  return guestAgent
    .post(`/event/${createdEvent.token}/upload`)
    .set('x-csrf-token', extractCsrfToken(uploadPage.text))
    .attach('photos', Buffer.from(`contenu de ${filename}`), { filename, contentType });
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

describe('Correctifs de revue de code', () => {
  let owner;

  beforeEach(async () => {
    userStore.resetTestState();
    eventFileStore.resetTestState();
    eventStore.resetTestState();
    eventArchiveRequestStore.resetTestState();
    settingsStore.resetTestState();

    await fs.rm(EVENT_STORAGE_ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    await fs.mkdir(EVENT_STORAGE_ROOT, { recursive: true });

    owner = await userStore.findByEmail('admin@example.com');
  });

  afterEach(() => {
    sinon.restore();
    delete process.env.SMTP_HOST;
    delete process.env.APP_BASE_URL;
  });

  function createActiveEvent(overrides = {}) {
    return eventStore.createEvent({
      ownerUserId: owner.id,
      name: 'Soiree de non-regression',
      description: 'Un evenement utilise par les tests de non-regression.',
      startsAt: '2099-06-01T19:00:00',
      status: 'active',
      ...overrides,
    });
  }

  describe('Uploads', () => {
    it('stocke un fichier .html declare image/png avec une extension d\'image, jamais .html', async () => {
      const createdEvent = await createActiveEvent();
      const guestAgent = request.agent(app);
      await registerGuestForEvent(guestAgent, createdEvent.token, 'Visiteur Malveillant');

      const response = await uploadAs(guestAgent, createdEvent, 'evil.html', 'image/png');

      expect(response.status).to.equal(201);
      expect(response.body.files[0].storedName).to.match(/\.png$/);
    });

    it('refuse un SVG (image scriptable)', async () => {
      const createdEvent = await createActiveEvent();
      const guestAgent = request.agent(app);
      await registerGuestForEvent(guestAgent, createdEvent.token, 'Visiteur SVG');

      const response = await uploadAs(guestAgent, createdEvent, 'evil.svg', 'image/svg+xml');

      expect(response.status).to.equal(415);
      expect(await eventFileStore.listByEvent(createdEvent.id)).to.have.lengthOf(0);
    });

    it('refuse l\'enregistrement d\'un fichier sur un evenement clos (cloture concurrente)', async () => {
      const createdEvent = await createActiveEvent();
      await eventStore.closeEvent(createdEvent.id);

      let caught = null;
      try {
        await eventFileStore.createFileRecord({
          eventId: createdEvent.id,
          originalName: 'tardive.jpg',
          storedName: '00000000-0000-0000-0000-000000000000.jpg',
          sizeBytes: 10,
          storagePath: 'events/x/original/tardive.jpg',
          moderationStatus: 'approved',
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).to.not.equal(null);
      expect(caught.code).to.equal('EVENT_CLOSED');
      expect(await eventFileStore.listByEvent(createdEvent.id)).to.have.lengthOf(0);
    });
  });

  it('echappe les noms fournis par les invites dans le slideshow', async () => {
    const createdEvent = await createActiveEvent();
    const guestAgent = request.agent(app);
    const hostileName = 'x\' onmouseover=\'alert(1)';
    await registerGuestForEvent(guestAgent, createdEvent.token, hostileName);
    expect((await uploadAs(guestAgent, createdEvent, 'photo.jpg', 'image/jpeg')).status).to.equal(201);

    const ownerAgent = request.agent(app);
    await login(ownerAgent);
    const slideshow = await ownerAgent.get(`/profile/events/${createdEvent.id}/slideshow`);

    expect(slideshow.status).to.equal(200);
    expect(slideshow.text).to.not.include(hostileName);
    expect(slideshow.text).to.include('x&#39; onmouseover=&#39;alert(1)');
  });

  it('ignore un cookie de demande d\'archive falsifie (pas de suppression pour autrui)', async () => {
    const createdEvent = await createActiveEvent();
    await eventArchiveRequestStore.upsertRequest(createdEvent.id, 'victime@example.com');

    const attacker = request.agent(app);
    await registerGuestForEvent(attacker, createdEvent.token, 'Attaquant');
    const eventPage = await attacker.get(`/event/${createdEvent.token}`);

    const response = await attacker
      .post(`/event/${createdEvent.token}/archive-request`)
      .set('Cookie', `event_archive_request_${createdEvent.token}=victime%40example.com`)
      .type('form')
      .send({ _csrf: extractCsrfToken(eventPage.text) });

    expect(response.status).to.equal(302);
    const requests = await eventArchiveRequestStore.listByEvent(createdEvent.id);
    expect(requests.map((item) => item.email)).to.deep.equal(['victime@example.com']);
  });

  it('envoie immediatement l\'archive a un invite inscrit apres sa generation', async () => {
    const createdEvent = await createActiveEvent();
    await eventStore.closeEvent(createdEvent.id);
    await eventStore.updateArchiveState(createdEvent.id, { archiveStatus: 'ready', archivePhotoCount: 0 });

    process.env.SMTP_HOST = 'smtp.test.local';
    process.env.APP_BASE_URL = 'https://picpix.test';
    await settingsStore.setBoolSetting('mail_archive_notifications_enabled', true);
    const sendMailStub = sinon.stub(mailService, 'sendMail').resolves();

    const guestAgent = request.agent(app);
    await registerGuestForEvent(guestAgent, createdEvent.token, 'Visiteur Tardif');
    const eventPage = await guestAgent.get(`/event/${createdEvent.token}`);
    await guestAgent
      .post(`/event/${createdEvent.token}/archive-request`)
      .type('form')
      .send({ _csrf: extractCsrfToken(eventPage.text), wantsArchive: '1', email: 'tardif@example.com' });

    await new Promise((resolve) => { setTimeout(resolve, 100); });

    expect(sendMailStub.calledOnce).to.equal(true);
    expect(sendMailStub.firstCall.args[0].to).to.equal('tardif@example.com');
    expect(sendMailStub.firstCall.args[0].text).to.include(`https://picpix.test/event/${createdEvent.token}/archive`);
  });

  it('n\'envoie aucun mail sans APP_BASE_URL et echappe le nom d\'evenement en HTML', async () => {
    const createdEvent = await createActiveEvent({ name: '<b>Soiree</b> & co' });
    await eventArchiveRequestStore.upsertRequest(createdEvent.id, 'invite@example.com');
    await settingsStore.setBoolSetting('mail_archive_notifications_enabled', true);
    process.env.SMTP_HOST = 'smtp.test.local';
    const sendMailStub = sinon.stub(mailService, 'sendMail').resolves();

    await archiveNotificationService.notifyArchiveRequesters(createdEvent);
    expect(sendMailStub.called).to.equal(false);

    process.env.APP_BASE_URL = 'https://picpix.test/';
    await archiveNotificationService.notifyArchiveRequesters(createdEvent);
    expect(sendMailStub.calledOnce).to.equal(true);
    expect(sendMailStub.firstCall.args[0].html).to.include('&lt;b&gt;Soiree&lt;/b&gt; &amp; co');
    expect(sendMailStub.firstCall.args[0].html).to.not.include('<b>Soiree</b>');
  });

  describe('Cloture', () => {
    it('accepte le mot-cle de confirmation entoure d\'espaces', async () => {
      const createdEvent = await createActiveEvent();
      const agent = request.agent(app);
      await login(agent);
      const profilePage = await agent.get('/profile');

      await agent
        .post(`/profile/events/${createdEvent.id}/close`)
        .type('form')
        .send({ _csrf: extractCsrfToken(profilePage.text), confirmClose: ' CLOTURER ' })
        .expect(302);

      expect((await eventStore.findById(createdEvent.id)).status).to.equal('closed');
      await waitForArchive(createdEvent.id);
    });

    it('refuse au niveau du store une cloture tant que des photos sont en attente', async () => {
      const createdEvent = await createActiveEvent({ moderationEnabled: true });
      await eventFileStore.createFileRecord({
        eventId: createdEvent.id,
        originalName: 'attente.jpg',
        storedName: '11111111-1111-1111-1111-111111111111.jpg',
        sizeBytes: 10,
        storagePath: 'events/x/original/attente.jpg',
        moderationStatus: 'pending',
      });

      let caught = null;
      try {
        await eventStore.closeEvent(createdEvent.id);
      } catch (err) {
        caught = err;
      }

      expect(caught).to.not.equal(null);
      expect(caught.code).to.equal('EVENT_PENDING_MODERATION');
      expect((await eventStore.findById(createdEvent.id)).status).to.equal('active');
    });
  });

  describe('Administration', () => {
    it('relance la generation d\'une archive en echec', async () => {
      const createdEvent = await createActiveEvent();
      await eventStore.closeEvent(createdEvent.id);
      await eventStore.updateArchiveState(createdEvent.id, { archiveStatus: 'failed', archiveError: 'disque plein' });

      const agent = request.agent(app);
      await login(agent);
      const dashboard = await agent.get('/admin');
      expect(dashboard.text).to.include(`/admin/events/${createdEvent.id}/archive/retry`);

      await agent
        .post(`/admin/events/${createdEvent.id}/archive/retry`)
        .type('form')
        .send({ _csrf: extractCsrfToken(dashboard.text) })
        .expect(302);

      const regenerated = await waitForArchive(createdEvent.id);
      expect(regenerated.archiveStatus).to.equal('ready');
    });

    it('supprime le stockage disque des evenements d\'un utilisateur supprime', async () => {
      const organiser = await userStore.createUser({
        email: 'organisateur@example.com',
        password: 'Organiser1234',
        fullName: 'Organisateur Test',
      });
      const createdEvent = await eventStore.createEvent({
        ownerUserId: organiser.id,
        name: 'Evenement a supprimer',
        description: 'Evenement dont le stockage doit disparaitre.',
        startsAt: '2099-06-01T19:00:00',
        status: 'active',
      });
      const storagePath = eventStore.getEventStoragePath(createdEvent.uuid);
      await fs.access(storagePath);

      const agent = request.agent(app);
      await login(agent);
      const dashboard = await agent.get('/admin');

      await agent
        .post(`/admin/users/${organiser.id}?_method=DELETE`)
        .type('form')
        .send({ _csrf: extractCsrfToken(dashboard.text) })
        .expect(302);

      expect(await userStore.findById(organiser.id)).to.equal(null);
      expect(await eventStore.findById(createdEvent.id)).to.equal(null);
      let storageStillExists = true;
      try {
        await fs.access(path.join(storagePath));
      } catch {
        storageStillExists = false;
      }
      expect(storageStillExists).to.equal(false);
    });
  });

  it('regenere l\'identifiant de session a la connexion', async () => {
    const agent = request.agent(app);
    const loginPage = await agent.get('/login');
    const preLoginSid = extractSetCookie(loginPage, 'sid');
    expect(preLoginSid).to.exist;

    const loginResponse = await agent
      .post('/login')
      .type('form')
      .send({ _csrf: extractCsrfToken(loginPage.text), email: 'admin@example.com', password: 'Admin1234' });
    const postLoginSid = extractSetCookie(loginResponse, 'sid');

    expect(postLoginSid).to.exist;
    expect(postLoginSid.split(';')[0]).to.not.equal(preLoginSid.split(';')[0]);
  });

  describe('Fuseau horaire', () => {
    it('interprete une heure murale dans APP_TIMEZONE et la restitue a l\'identique', () => {
      expect(timezone.APP_TIMEZONE).to.equal('Europe/Paris');

      const summer = timezone.parseAppDateTime('2026-07-01T20:00');
      expect(summer.toISOString()).to.equal('2026-07-01T18:00:00.000Z');
      expect(timezone.toDateTimeLocal(summer)).to.equal('2026-07-01T20:00');

      const winter = timezone.parseAppDateTime('2026-01-15T20:00');
      expect(winter.toISOString()).to.equal('2026-01-15T19:00:00.000Z');
      expect(timezone.toDateTimeLocal(winter.toISOString())).to.equal('2026-01-15T20:00');

      // Une valeur avec decalage explicite est conservee telle quelle.
      expect(timezone.parseAppDateTime('2026-07-01T20:00:00Z').toISOString()).to.equal('2026-07-01T20:00:00.000Z');
    });
  });
});
