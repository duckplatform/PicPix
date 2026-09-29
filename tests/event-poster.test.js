'use strict';

/**
 * QR code du lien invite et affiche PDF a imprimer (pages admin et organisateur).
 */

const request = require('supertest');
const { expect } = require('chai');

const app = require('../app');
const eventFileStore = require('../services/eventFileStore');
const eventPosterService = require('../services/eventPosterService');
const eventStore = require('../services/eventStore');
const userStore = require('../services/userStore');

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!match) {
    throw new Error('Token CSRF introuvable dans la page');
  }

  return match[1];
}

async function login(agent, email = 'admin@example.com', password = 'Admin1234') {
  const loginPage = await agent.get('/login');
  const loginResponse = await agent
    .post('/login')
    .type('form')
    .send({ _csrf: extractCsrfToken(loginPage.text), email, password });

  expect(loginResponse.status).to.equal(302);
}

/** supertest ne bufferise pas les reponses binaires par defaut. */
function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function createEventFor(ownerEmail, overrides = {}) {
  const owner = await userStore.findByEmail(ownerEmail);
  return eventStore.createEvent({
    ownerUserId: owner.id,
    name: 'Mariage de Camille & Léo 💍',
    description: 'Une belle journee a partager.',
    startsAt: '2026-10-17T18:30',
    status: 'active',
    theme: 'wedding',
    ...overrides,
  });
}

describe('QR code et affiche PDF des evenements', () => {
  beforeEach(() => {
    userStore.resetTestState();
    eventFileStore.resetTestState();
    eventStore.resetTestState();
  });

  describe('eventPosterService', () => {
    it('genere un PDF A4 pour chaque theme', async () => {
      for (const themeKey of Object.keys(eventPosterService.POSTER_THEMES)) {
        const pdf = await eventPosterService.renderPosterPdf({
          name: `Soiree ${themeKey}`,
          token: 'AbCdEfGhIj',
          theme: themeKey,
          startsAt: '2026-10-17T18:30:00Z',
          uploadSourceMode: 'default',
          moderationEnabled: false,
        }, 'https://picpix.example.com/event/AbCdEfGhIj');

        expect(pdf.subarray(0, 5).toString()).to.equal('%PDF-');
      }
    });

    it('retire les caracteres hors WinAnsi (emojis) du texte imprime', () => {
      expect(eventPosterService.toPdfText('Mariage de Camille & Léo 💍')).to.equal('Mariage de Camille & Léo');
    });

    it('construit des noms de fichiers ASCII', () => {
      const eventItem = { name: 'Soirée d\'été 🎉', token: 'AbCdEfGhIj' };
      expect(eventPosterService.buildPosterFileName(eventItem)).to.equal('affiche-soiree-d-ete.pdf');
      expect(eventPosterService.buildQrFileName({ name: '🎉', token: 'AbCdEfGhIj' })).to.equal('qr-code-AbCdEfGhIj.png');
    });
  });

  describe('Routes', () => {
    it('affiche le QR code et le lien invite sur la page admin de l\'evenement', async () => {
      const createdEvent = await createEventFor('admin@example.com');
      const agent = request.agent(app);
      await login(agent);

      const page = await agent.get(`/admin/events/${createdEvent.id}/edit`);
      expect(page.status).to.equal(200);
      expect(page.text).to.include(`/admin/events/${createdEvent.id}/qr.png`);
      expect(page.text).to.include(`/admin/events/${createdEvent.id}/poster.pdf`);
      expect(page.text).to.include(`/event/${createdEvent.token}`);
    });

    it('sert le QR code PNG et l\'affiche PDF a l\'administrateur', async () => {
      const createdEvent = await createEventFor('admin@example.com');
      const agent = request.agent(app);
      await login(agent);

      const qr = await agent.get(`/admin/events/${createdEvent.id}/qr.png?download=1`).buffer(true).parse(binaryParser);
      expect(qr.status).to.equal(200);
      expect(qr.headers['content-type']).to.match(/^image\/png/);
      expect(qr.headers['cache-control']).to.equal('no-store');
      expect(qr.headers['content-disposition']).to.include('qr-code-mariage-de-camille-leo.png');
      expect(qr.body.subarray(1, 4).toString()).to.equal('PNG');

      const poster = await agent.get(`/admin/events/${createdEvent.id}/poster.pdf`).buffer(true).parse(binaryParser);
      expect(poster.status).to.equal(200);
      expect(poster.headers['content-type']).to.match(/^application\/pdf/);
      expect(poster.headers['content-disposition']).to.equal('inline; filename="affiche-mariage-de-camille-leo.pdf"');
      expect(poster.body.subarray(0, 5).toString()).to.equal('%PDF-');
    });

    it('reserve le QR code et l\'affiche au proprietaire de l\'evenement', async () => {
      await userStore.createUser({ email: 'orga@example.com', password: 'SecurePass123', fullName: 'Orga' });
      await userStore.createUser({ email: 'autre@example.com', password: 'SecurePass123', fullName: 'Autre' });
      const createdEvent = await createEventFor('orga@example.com');

      const anonymous = await request(app).get(`/profile/events/${createdEvent.id}/poster.pdf`);
      expect(anonymous.status).to.equal(302);

      const otherAgent = request.agent(app);
      await login(otherAgent, 'autre@example.com', 'SecurePass123');
      expect((await otherAgent.get(`/profile/events/${createdEvent.id}/qr.png`)).status).to.equal(404);
      expect((await otherAgent.get(`/profile/events/${createdEvent.id}/poster.pdf`)).status).to.equal(404);
      expect((await otherAgent.get(`/admin/events/${createdEvent.id}/poster.pdf`)).status).to.not.equal(200);

      const ownerAgent = request.agent(app);
      await login(ownerAgent, 'orga@example.com', 'SecurePass123');
      const page = await ownerAgent.get(`/profile/events/${createdEvent.id}/edit`);
      expect(page.text).to.include(`/profile/events/${createdEvent.id}/poster.pdf`);

      const poster = await ownerAgent.get(`/profile/events/${createdEvent.id}/poster.pdf`).buffer(true).parse(binaryParser);
      expect(poster.status).to.equal(200);
      expect(poster.body.subarray(0, 5).toString()).to.equal('%PDF-');

      const qr = await ownerAgent.get(`/profile/events/${createdEvent.id}/qr.png`).buffer(true).parse(binaryParser);
      expect(qr.status).to.equal(200);
      expect(qr.headers['content-disposition']).to.equal(undefined);
    });

    it('encode APP_BASE_URL dans le lien invite quand il est configure', async () => {
      const previousBaseUrl = process.env.APP_BASE_URL;
      process.env.APP_BASE_URL = 'https://photos.example.org/';

      try {
        const createdEvent = await createEventFor('admin@example.com');
        const agent = request.agent(app);
        await login(agent);

        const page = await agent.get(`/admin/events/${createdEvent.id}/edit`);
        expect(page.text).to.include(`https://photos.example.org/event/${createdEvent.token}`);
      } finally {
        if (previousBaseUrl === undefined) {
          delete process.env.APP_BASE_URL;
        } else {
          process.env.APP_BASE_URL = previousBaseUrl;
        }
      }
    });
  });
});
