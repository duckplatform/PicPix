'use strict';

const fs = require('fs/promises');
const path = require('path');
const request = require('supertest');
const { expect } = require('chai');

const app = require('../app');
const eventFileStore = require('../services/eventFileStore');
const userStore = require('../services/userStore');
const eventStore = require('../services/eventStore');

const EVENT_STORAGE_ROOT = eventStore.getEventStorageRoot();

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!match) {
    throw new Error('Token CSRF introuvable dans la page');
  }

  return match[1];
}

async function registerGuestForEvent(agent, token, guestName = 'Visiteur Test') {
  const registerPage = await agent.get(`/event/${token}/register`);
  expect(registerPage.status).to.equal(200);
  const csrfToken = extractCsrfToken(registerPage.text);

  const registerResponse = await agent
    .post(`/event/${token}/register`)
    .type('form')
    .send({
      _csrf: csrfToken,
      guestName,
    });

  expect(registerResponse.status).to.equal(302);
  expect(registerResponse.headers.location).to.equal(`/event/${token}`);
}

describe('Tests applicatifs HTTP', () => {
  beforeEach(async () => {
    userStore.resetTestState();
    eventFileStore.resetTestState();
    eventStore.resetTestState();

    await fs.rm(EVENT_STORAGE_ROOT, { recursive: true, force: true });
    await fs.mkdir(EVENT_STORAGE_ROOT, { recursive: true });
  });

  describe('Pages publiques', () => {
    it('GET / retourne 200 et le contenu de la page accueil', async () => {
      const res = await request(app).get('/');

      expect(res.status).to.equal(200);
      expect(res.text).to.include('Bienvenue sur PicPix');
      expect(res.headers['content-type']).to.match(/text\/html/);
    });

    it('GET /styles.css retourne 200', async () => {
      const res = await request(app).get('/styles.css');

      expect(res.status).to.equal(200);
      expect(res.headers['content-type']).to.match(/text\/css/);
    });

    it('GET /inconnu retourne 404', async () => {
      const res = await request(app).get('/inconnu');

      expect(res.status).to.equal(404);
      expect(res.text).to.include('La page demandee est introuvable');
    });

    it('GET /event/:token affiche le bienvenue si l\'evenement est actif avant l\'heure', async () => {
      const owner = await userStore.findByEmail('admin@example.com');
      const createdEvent = await eventStore.createEvent({
        ownerUserId: owner.id,
        name: 'Concert Public',
        description: 'Grand concert public en plein air.',
        startsAt: '2099-09-20T20:00',
        status: 'active',
      });

      const agent = request.agent(app);
      const preAccess = await agent.get(`/event/${createdEvent.token}`);
      expect(preAccess.status).to.equal(302);
      expect(preAccess.headers.location).to.equal(`/event/${createdEvent.token}/register`);

      await registerGuestForEvent(agent, createdEvent.token, 'Alex Event');

      const res = await agent.get(`/event/${createdEvent.token}`);

      expect(res.status).to.equal(200);
      expect(res.text).to.include('Concert Public');
      expect(res.text).to.include('Grand concert public en plein air.');
      expect(res.text).to.include('id="countdownScreen" class="countdown-screen" aria-live="polite" hidden');
      expect(res.text).to.include('id="welcomeScreen" class="welcome-screen" aria-live="polite" >');
    });

    it('GET /event/:token affiche le chrono si l\'evenement n\'a pas commence', async () => {
      const owner = await userStore.findByEmail('admin@example.com');
      const createdEvent = await eventStore.createEvent({
        ownerUserId: owner.id,
        name: 'Lancement Produit',
        description: 'Ouverture des portes dans quelques heures.',
        startsAt: '2099-12-31T23:59:00',
        status: 'inactive',
      });

      const agent = request.agent(app);
      await registerGuestForEvent(agent, createdEvent.token, 'Nora Timer');

      const res = await agent.get(`/event/${createdEvent.token}`);

      expect(res.status).to.equal(200);
      expect(res.text).to.include('id="countdownScreen" class="countdown-screen" aria-live="polite" >');
      expect(res.text).to.include('id="welcomeScreen" class="welcome-screen" aria-live="polite" hidden');
    });

    it('GET /event/:token applique la classe CSS du theme configure', async () => {
      const owner = await userStore.findByEmail('admin@example.com');
      const createdEvent = await eventStore.createEvent({
        ownerUserId: owner.id,
        name: 'Nuit Cinema',
        description: 'Projection publique en plein air.',
        startsAt: '2099-09-20T20:00',
        status: 'active',
        theme: 'cinema',
      });

      const agent = request.agent(app);
      await registerGuestForEvent(agent, createdEvent.token, 'Lea Cinema');

      const eventPage = await agent.get(`/event/${createdEvent.token}`);

      expect(eventPage.status).to.equal(200);
      expect(eventPage.text).to.include('class="page-event event-theme-cinema"');
    });

    it('GET /event/:token/register redirige vers /event/:token si le cookie visiteur existe deja', async () => {
      const owner = await userStore.findByEmail('admin@example.com');
      const createdEvent = await eventStore.createEvent({
        ownerUserId: owner.id,
        name: 'Conference Invite',
        description: 'Conference privee avec inscription visiteur.',
        startsAt: '2099-11-02T10:00:00',
        status: 'inactive',
      });

      const agent = request.agent(app);
      await registerGuestForEvent(agent, createdEvent.token, 'Camille');

      const registerPage = await agent.get(`/event/${createdEvent.token}/register`);
      expect(registerPage.status).to.equal(302);
      expect(registerPage.headers.location).to.equal(`/event/${createdEvent.token}`);
    });

    it('GET /event/:token/upload redirige vers le register si le visiteur n\'est pas encore identifie', async () => {
      const owner = await userStore.findByEmail('admin@example.com');
      const createdEvent = await eventStore.createEvent({
        ownerUserId: owner.id,
        name: 'Galerie publique',
        description: 'Evenement ouvert aux uploads visiteurs.',
        startsAt: '2099-06-01T19:00:00',
        status: 'active',
      });

      const res = await request(app).get(`/event/${createdEvent.token}/upload`);
      expect(res.status).to.equal(302);
      expect(res.headers.location).to.equal(`/event/${createdEvent.token}/register`);
    });

    it('GET /event/:token/upload applique les options d\'upload configurees sur l\'evenement', async () => {
      const owner = await userStore.findByEmail('admin@example.com');
      const createdEvent = await eventStore.createEvent({
        ownerUserId: owner.id,
        name: 'Capture terrain',
        description: 'Photos terrain depuis smartphone.',
        startsAt: '2099-06-01T19:00:00',
        status: 'active',
        uploadSourceMode: 'camera_only',
        uploadAllowMultiple: false,
      });

      const agent = request.agent(app);
      await registerGuestForEvent(agent, createdEvent.token, 'Mobile User');

      const uploadPage = await agent.get(`/event/${createdEvent.token}/upload`);
      expect(uploadPage.status).to.equal(200);
      expect(uploadPage.text).to.include('id="upload-source-mode" value="camera_only"');
      expect(uploadPage.text).to.include('id="upload-allow-multiple" value="0"');
    });

    it('POST /event/:token/upload stocke une photo avec nom physique UUID et metadata en base', async () => {
      const owner = await userStore.findByEmail('admin@example.com');
      const createdEvent = await eventStore.createEvent({
        ownerUserId: owner.id,
        name: 'Mur Photo',
        description: 'Televersement de photos visiteurs.',
        startsAt: '2099-06-01T19:00:00',
        status: 'active',
      });

      const agent = request.agent(app);
      await registerGuestForEvent(agent, createdEvent.token, 'Photographe Invite');

      const uploadPage = await agent.get(`/event/${createdEvent.token}/upload`);
      const uploadCsrfToken = extractCsrfToken(uploadPage.text);

      const uploadResponse = await agent
        .post(`/event/${createdEvent.token}/upload`)
        .set('x-csrf-token', uploadCsrfToken)
        .attach('photos', Buffer.from('fake image payload'), {
          filename: 'photo-souvenir.jpg',
          contentType: 'image/jpeg',
        });

      expect(uploadResponse.status).to.equal(201);
      expect(uploadResponse.body.files).to.have.lengthOf(1);
      expect(uploadResponse.body.files[0].originalName).to.equal('photo-souvenir.jpg');
      expect(uploadResponse.body.files[0].storedName).to.match(/^[0-9a-f-]{36}\.jpg$/i);
      expect(uploadResponse.body.files[0].storedName).to.not.equal('photo-souvenir.jpg');
      expect(uploadResponse.body.files[0].storagePath).to.equal(`events/${createdEvent.uuid}/original/${uploadResponse.body.files[0].storedName}`);
      expect(uploadResponse.body.files[0].checksumSha256).to.match(/^[0-9a-f]{64}$/i);
      expect(uploadResponse.body.files[0].moderationStatus).to.equal('approved');

      const eventFiles = await eventFileStore.listByEvent(createdEvent.id);
      expect(eventFiles).to.have.lengthOf(1);
      expect(eventFiles[0].originalName).to.equal('photo-souvenir.jpg');
      expect(eventFiles[0].moderationStatus).to.equal('approved');

      const storedFilePath = path.join(EVENT_STORAGE_ROOT, createdEvent.uuid, 'original', eventFiles[0].storedName);
      expect(await pathExists(storedFilePath)).to.equal(true);
    });

    it('GET /event/:token/gallery affiche les photos avec route media securisee', async () => {
      const owner = await userStore.findByEmail('admin@example.com');
      const createdEvent = await eventStore.createEvent({
        ownerUserId: owner.id,
        name: 'Galerie Invite',
        description: 'Consultation des photos depuis une galerie dediee.',
        startsAt: '2099-06-01T19:00:00',
        status: 'active',
      });

      const agent = request.agent(app);
      await registerGuestForEvent(agent, createdEvent.token, 'Visiteur Galerie');

      const uploadPage = await agent.get(`/event/${createdEvent.token}/upload`);
      const uploadCsrfToken = extractCsrfToken(uploadPage.text);

      const uploadResponse = await agent
        .post(`/event/${createdEvent.token}/upload`)
        .set('x-csrf-token', uploadCsrfToken)
        .attach('photos', Buffer.from('fake image payload'), {
          filename: 'photo-galerie.jpg',
          contentType: 'image/jpeg',
        });

      expect(uploadResponse.status).to.equal(201);
      const storedName = uploadResponse.body.files[0].storedName;

      const galleryPage = await agent.get(`/event/${createdEvent.token}/gallery`);
      expect(galleryPage.status).to.equal(200);
      expect(galleryPage.text).to.include('Galerie evenement');
      expect(galleryPage.text).to.include(`/event/${createdEvent.token}/media/${storedName}/original`);
    });

    it('POST /event/:token/upload accepte aussi le format de champs photos[index] emis par Dropzone en multi-upload', async () => {
      const owner = await userStore.findByEmail('admin@example.com');
      const createdEvent = await eventStore.createEvent({
        ownerUserId: owner.id,
        name: 'Galerie Dropzone',
        description: 'Upload multi-fichiers depuis Dropzone.',
        startsAt: '2099-06-01T19:00:00',
        status: 'active',
      });

      const agent = request.agent(app);
      await registerGuestForEvent(agent, createdEvent.token, 'Dropzone User');

      const uploadPage = await agent.get(`/event/${createdEvent.token}/upload`);
      const uploadCsrfToken = extractCsrfToken(uploadPage.text);

      const uploadResponse = await agent
        .post(`/event/${createdEvent.token}/upload`)
        .set('x-csrf-token', uploadCsrfToken)
        .attach('photos[0]', Buffer.from('fake image payload 1'), {
          filename: 'photo-1.jpg',
          contentType: 'image/jpeg',
        })
        .attach('photos[1]', Buffer.from('fake image payload 2'), {
          filename: 'photo-2.jpg',
          contentType: 'image/jpeg',
        });

      expect(uploadResponse.status).to.equal(201);
      expect(uploadResponse.body.files).to.have.lengthOf(2);
      expect(uploadResponse.body.files[0].originalName).to.equal('photo-1.jpg');
      expect(uploadResponse.body.files[1].originalName).to.equal('photo-2.jpg');
    });

    it('POST /event/:token/upload refuse plusieurs fichiers si l\'evenement desactive les uploads multiples', async () => {
      const owner = await userStore.findByEmail('admin@example.com');
      const createdEvent = await eventStore.createEvent({
        ownerUserId: owner.id,
        name: 'Portrait minute',
        description: 'Une photo par envoi uniquement.',
        startsAt: '2099-06-01T19:00:00',
        status: 'active',
        uploadAllowMultiple: false,
      });

      const agent = request.agent(app);
      await registerGuestForEvent(agent, createdEvent.token, 'Solo Shooter');

      const uploadPage = await agent.get(`/event/${createdEvent.token}/upload`);
      const uploadCsrfToken = extractCsrfToken(uploadPage.text);

      const uploadResponse = await agent
        .post(`/event/${createdEvent.token}/upload`)
        .set('x-csrf-token', uploadCsrfToken)
        .attach('photos', Buffer.from('fake image payload 1'), {
          filename: 'photo-1.jpg',
          contentType: 'image/jpeg',
        })
        .attach('photos', Buffer.from('fake image payload 2'), {
          filename: 'photo-2.jpg',
          contentType: 'image/jpeg',
        });

      expect(uploadResponse.status).to.equal(413);
      expect(uploadResponse.body.message).to.include('Trop de fichiers');
    });

    it('GET /event/:token retourne 404 si le token est inconnu', async () => {
      const res = await request(app).get('/event/AAAAAAAAAA');

      expect(res.status).to.equal(404);
      expect(res.text).to.include('La page demandee est introuvable');
    });
  });

  describe('Monitoring', () => {
    it('GET /health retourne un statut OK en environnement de test', async () => {
      const res = await request(app).get('/health');

      expect(res.status).to.equal(200);
      expect(res.body).to.deep.equal({
        status: 'ok',
        database: 'up',
      });
    });
  });

  describe('Authentification et profil', () => {
    it('permet l\'inscription puis l\'acces au profil', async () => {
      const agent = request.agent(app);
      const registerPage = await agent.get('/register');
      const csrfToken = extractCsrfToken(registerPage.text);

      const registerResponse = await agent
        .post('/register')
        .type('form')
        .send({
          _csrf: csrfToken,
          fullName: 'Alice Martin',
          email: 'alice@example.com',
          password: 'SecurePass123',
          confirmPassword: 'SecurePass123',
        });

      expect(registerResponse.status).to.equal(302);
      expect(registerResponse.headers.location).to.equal('/profile');

      const profileResponse = await agent.get('/profile');
      expect(profileResponse.status).to.equal(200);
      expect(profileResponse.text).to.include('Alice Martin');
      expect(profileResponse.text).to.include('alice@example.com');
    });

    it('permet la connexion avec le compte admin par defaut', async () => {
      const agent = request.agent(app);
      const loginPage = await agent.get('/login');
      const csrfToken = extractCsrfToken(loginPage.text);

      const loginResponse = await agent
        .post('/login')
        .type('form')
        .send({
          _csrf: csrfToken,
          email: 'admin@example.com',
          password: 'Admin1234',
        });

      expect(loginResponse.status).to.equal(302);
      expect(loginResponse.headers.location).to.equal('/profile');

      const adminResponse = await agent.get('/admin');
      expect(adminResponse.status).to.equal(200);
      expect(adminResponse.text).to.include('Gestion des utilisateurs');
      expect(adminResponse.text).to.include('admin@example.com');
    });

    it('refuse l\'acces a l\'administration pour un utilisateur standard', async () => {
      const agent = request.agent(app);
      const registerPage = await agent.get('/register');
      const csrfToken = extractCsrfToken(registerPage.text);

      await agent
        .post('/register')
        .type('form')
        .send({
          _csrf: csrfToken,
          fullName: 'Bob Standard',
          email: 'bob@example.com',
          password: 'SecurePass123',
          confirmPassword: 'SecurePass123',
        })
        .expect(302);

      const adminResponse = await agent.get('/admin');
      expect(adminResponse.status).to.equal(403);
      expect(adminResponse.text).to.include('droits necessaires');
    });

    it('permet a un utilisateur de creer et consulter ses evenements depuis le profil', async () => {
      const agent = request.agent(app);
      const registerPage = await agent.get('/register');
      const registerCsrf = extractCsrfToken(registerPage.text);

      await agent
        .post('/register')
        .type('form')
        .send({
          _csrf: registerCsrf,
          fullName: 'Eva Event',
          email: 'eva@example.com',
          password: 'SecurePass123',
          confirmPassword: 'SecurePass123',
        })
        .expect(302);

      const profilePage = await agent.get('/profile');
      const profileCsrf = extractCsrfToken(profilePage.text);

      const createEventResponse = await agent
        .post('/profile/events')
        .type('form')
        .send({
          _csrf: profileCsrf,
          name: 'Festival Printemps',
          description: 'Festival culturel et musical du printemps.',
          startsAt: '2026-05-01T19:30',
          status: 'active',
          slideshowTransition: 'zoom',
          uploadSourceMode: 'library_only',
        });

      expect(createEventResponse.status).to.equal(302);
      expect(createEventResponse.headers.location).to.equal('/profile');

      const refreshedProfile = await agent.get('/profile');
      expect(refreshedProfile.status).to.equal(200);
      expect(refreshedProfile.text).to.include('Festival Printemps');

      const owner = await userStore.findByEmail('eva@example.com');
      const events = await eventStore.listByOwner(owner.id);
      expect(events).to.have.lengthOf(1);
      expect(events[0].uuid).to.match(/^[0-9a-f-]{36}$/i);
      expect(events[0].token).to.match(/^[A-Za-z0-9]{10}$/);
      expect(events[0].status).to.equal('active');
      expect(events[0].description).to.equal('Festival culturel et musical du printemps.');
      expect(events[0].slideshowTransition).to.equal('zoom');
      expect(events[0].uploadSourceMode).to.equal('library_only');
      expect(events[0].uploadAllowMultiple).to.equal(false);
      expect(events[0].moderationEnabled).to.equal(false);

      const eventStoragePath = path.join(EVENT_STORAGE_ROOT, events[0].uuid);
      expect(await pathExists(eventStoragePath)).to.equal(true);

      const ownerGallery = await agent.get(`/profile/events/${events[0].id}/gallery`);
      expect(ownerGallery.status).to.equal(200);
      expect(ownerGallery.text).to.include('Galerie proprietaire');

      const ownerSlideshow = await agent.get(`/profile/events/${events[0].id}/slideshow`);
      expect(ownerSlideshow.status).to.equal(200);
      expect(ownerSlideshow.text).to.include('slideshow-shell');
      expect(ownerSlideshow.text).to.include('event-theme-classic');
      expect(ownerSlideshow.text).to.include('data-transition="zoom"');
    });

    it('applique le theme configure sur la page slideshow proprietaire', async () => {
      const owner = await userStore.findByEmail('admin@example.com');
      const themedEvent = await eventStore.createEvent({
        ownerUserId: owner.id,
        name: 'Session Halloween',
        description: 'Projection pour la soiree Halloween.',
        startsAt: '2099-10-31T20:00:00',
        status: 'active',
        theme: 'halloween',
      });

      const agent = request.agent(app);
      const loginPage = await agent.get('/login');
      const csrfToken = extractCsrfToken(loginPage.text);

      await agent
        .post('/login')
        .type('form')
        .send({
          _csrf: csrfToken,
          email: 'admin@example.com',
          password: 'Admin1234',
        })
        .expect(302);

      const slideshow = await agent.get(`/profile/events/${themedEvent.id}/slideshow`);
      expect(slideshow.status).to.equal(200);
      expect(slideshow.text).to.include('event-theme-halloween');
    });

    it('sanitise la description markdown lors de la creation d\'evenement', async () => {
      const agent = request.agent(app);
      const registerPage = await agent.get('/register');
      const registerCsrf = extractCsrfToken(registerPage.text);

      await agent
        .post('/register')
        .type('form')
        .send({
          _csrf: registerCsrf,
          fullName: 'Rich Text User',
          email: 'richtext@example.com',
          password: 'SecurePass123',
          confirmPassword: 'SecurePass123',
        })
        .expect(302);

      const profilePage = await agent.get('/profile');
      const profileCsrf = extractCsrfToken(profilePage.text);

      await agent
        .post('/profile/events')
        .type('form')
        .send({
          _csrf: profileCsrf,
          name: 'Session Rich Text',
          description: 'Bienvenue **public**\n\n<script>alert("x")</script>',
          startsAt: '2026-08-20T19:30',
          status: 'inactive',
        })
        .expect(302);

      const owner = await userStore.findByEmail('richtext@example.com');
      const events = await eventStore.listByOwner(owner.id);
      expect(events).to.have.lengthOf(1);
      expect(events[0].description).to.include('**public**');
      expect(events[0].description).to.not.include('<script>');

      const eventAgent = request.agent(app);
      await registerGuestForEvent(eventAgent, events[0].token, 'Lecteur Markdown');
      const eventPage = await eventAgent.get(`/event/${events[0].token}`);
      expect(eventPage.status).to.equal(200);
      expect(eventPage.text).to.include('<strong>public</strong>');
      expect(eventPage.text).to.not.include('alert("x")');
    });

    it('met en attente les photos d\'un evenement modere jusqu\'a validation via /profile/event/:id/moderation', async () => {
      const ownerAgent = request.agent(app);
      const registerPage = await ownerAgent.get('/register');
      const registerCsrf = extractCsrfToken(registerPage.text);

      await ownerAgent
        .post('/register')
        .type('form')
        .send({
          _csrf: registerCsrf,
          fullName: 'Moderateur Event',
          email: 'moderateur@example.com',
          password: 'SecurePass123',
          confirmPassword: 'SecurePass123',
        })
        .expect(302);

      const profilePage = await ownerAgent.get('/profile');
      const profileCsrf = extractCsrfToken(profilePage.text);

      await ownerAgent
        .post('/profile/events')
        .type('form')
        .send({
          _csrf: profileCsrf,
          name: 'Evenement modere',
          description: 'Evenement public avec validation manuelle des photos.',
          startsAt: '2026-09-01T19:30',
          status: 'active',
          moderationEnabled: '1',
        })
        .expect(302);

      const owner = await userStore.findByEmail('moderateur@example.com');
      const [createdEvent] = await eventStore.listByOwner(owner.id);
      expect(createdEvent.moderationEnabled).to.equal(true);

      const guestAgent = request.agent(app);
      await registerGuestForEvent(guestAgent, createdEvent.token, 'Visiteur Modere');

      const uploadPage = await guestAgent.get(`/event/${createdEvent.token}/upload`);
      expect(uploadPage.status).to.equal(200);
      expect(uploadPage.text).to.include('publiees apres validation');
      const uploadCsrfToken = extractCsrfToken(uploadPage.text);

      const uploadResponse = await guestAgent
        .post(`/event/${createdEvent.token}/upload`)
        .set('x-csrf-token', uploadCsrfToken)
        .attach('photos', Buffer.from('fake moderated payload'), {
          filename: 'photo-moderee.jpg',
          contentType: 'image/jpeg',
        });

      expect(uploadResponse.status).to.equal(201);
      expect(uploadResponse.body.message).to.include('Publication apres moderation');
      expect(uploadResponse.body.files).to.have.lengthOf(1);
      expect(uploadResponse.body.files[0].moderationStatus).to.equal('pending');

      const pendingFile = uploadResponse.body.files[0];

      const publicGalleryBefore = await guestAgent.get(`/event/${createdEvent.token}/gallery`);
      expect(publicGalleryBefore.status).to.equal(200);
      expect(publicGalleryBefore.text).to.include('Aucune photo disponible');
      expect(publicGalleryBefore.text).to.not.include(pendingFile.storedName);

      const publicMediaBefore = await guestAgent.get(`/event/${createdEvent.token}/media/${pendingFile.storedName}/original`);
      expect(publicMediaBefore.status).to.equal(404);

      const ownerSlideshowBefore = await ownerAgent.get(`/profile/events/${createdEvent.id}/slideshow`);
      expect(ownerSlideshowBefore.status).to.equal(200);
      expect(ownerSlideshowBefore.text).to.not.include(pendingFile.storedName);

      const moderationPage = await ownerAgent.get(`/profile/event/${createdEvent.id}/moderation`);
      expect(moderationPage.status).to.equal(200);
      expect(moderationPage.text).to.include('Moderation des photos');
      expect(moderationPage.text).to.include('photo-moderee.jpg');
      const moderationCsrf = extractCsrfToken(moderationPage.text);

      await ownerAgent
        .post(`/profile/event/${createdEvent.id}/moderation/${pendingFile.id}`)
        .type('form')
        .send({
          _csrf: moderationCsrf,
          moderationStatus: 'approved',
        })
        .expect(302);

      const approvedFile = await eventFileStore.findByEventAndStoredName(createdEvent.id, pendingFile.storedName);
      expect(approvedFile).to.not.equal(null);
      expect(approvedFile.moderationStatus).to.equal('approved');

      const publicGalleryAfter = await guestAgent.get(`/event/${createdEvent.token}/gallery`);
      expect(publicGalleryAfter.status).to.equal(200);
      expect(publicGalleryAfter.text).to.include(`/event/${createdEvent.token}/media/${pendingFile.storedName}/original`);

      const publicMediaAfter = await guestAgent.get(`/event/${createdEvent.token}/media/${pendingFile.storedName}/original`);
      expect(publicMediaAfter.status).to.equal(200);

      const ownerSlideshowAfter = await ownerAgent.get(`/profile/events/${createdEvent.id}/slideshow`);
      expect(ownerSlideshowAfter.status).to.equal(200);
      expect(ownerSlideshowAfter.text).to.include(pendingFile.storedName);
    });

    it('approuve automatiquement les photos en attente quand la moderation est desactivee', async () => {
      const ownerAgent = request.agent(app);
      const registerPage = await ownerAgent.get('/register');
      const registerCsrf = extractCsrfToken(registerPage.text);

      await ownerAgent
        .post('/register')
        .type('form')
        .send({
          _csrf: registerCsrf,
          fullName: 'Toggle Moderation',
          email: 'toggle@example.com',
          password: 'SecurePass123',
          confirmPassword: 'SecurePass123',
        })
        .expect(302);

      const profilePage = await ownerAgent.get('/profile');
      expect(profilePage.status).to.equal(200);
      const profileCsrf = extractCsrfToken(profilePage.text);

      await ownerAgent
        .post('/profile/events')
        .type('form')
        .send({
          _csrf: profileCsrf,
          name: 'Evenement toggle moderation',
          description: 'Evenement avec bascule de moderation pour publication automatique.',
          startsAt: '2026-10-01T19:30',
          status: 'active',
          moderationEnabled: '1',
        })
        .expect(302);

      const owner = await userStore.findByEmail('toggle@example.com');
      const [createdEvent] = await eventStore.listByOwner(owner.id);
      expect(createdEvent.moderationEnabled).to.equal(true);

      const profileWithEvent = await ownerAgent.get('/profile');
      expect(profileWithEvent.status).to.equal(200);
      expect(profileWithEvent.text).to.include(`/profile/events/${createdEvent.id}/slideshow`);
      expect(profileWithEvent.text).to.include('Slideshow');

      const guestAgent = request.agent(app);
      await registerGuestForEvent(guestAgent, createdEvent.token, 'Visiteur Toggle');

      const uploadPage = await guestAgent.get(`/event/${createdEvent.token}/upload`);
      const uploadCsrfToken = extractCsrfToken(uploadPage.text);

      const uploadResponse = await guestAgent
        .post(`/event/${createdEvent.token}/upload`)
        .set('x-csrf-token', uploadCsrfToken)
        .attach('photos', Buffer.from('pending payload'), {
          filename: 'pending-before-toggle.jpg',
          contentType: 'image/jpeg',
        });

      expect(uploadResponse.status).to.equal(201);
      const pendingFile = uploadResponse.body.files[0];
      expect(pendingFile.moderationStatus).to.equal('pending');

      const editPage = await ownerAgent.get(`/profile/events/${createdEvent.id}/edit`);
      const editCsrf = extractCsrfToken(editPage.text);

      await ownerAgent
        .post(`/profile/events/${createdEvent.id}?_method=PUT`)
        .type('form')
        .send({
          _csrf: editCsrf,
          name: createdEvent.name,
          description: createdEvent.description,
          startsAt: new Date(createdEvent.startsAt).toISOString().slice(0, 16),
          status: 'active',
          theme: createdEvent.theme,
          slideshowTransition: createdEvent.slideshowTransition,
          uploadSourceMode: createdEvent.uploadSourceMode,
          uploadAllowMultiple: createdEvent.uploadAllowMultiple ? '1' : undefined,
          // moderationEnabled absent => false (checkbox decochee)
        })
        .expect(302);

      const updatedEvent = await eventStore.findById(createdEvent.id);
      expect(updatedEvent.moderationEnabled).to.equal(false);

      const approvedFile = await eventFileStore.findByEventAndStoredName(createdEvent.id, pendingFile.storedName);
      expect(approvedFile).to.not.equal(null);
      expect(approvedFile.moderationStatus).to.equal('approved');

      const publicGalleryAfter = await guestAgent.get(`/event/${createdEvent.token}/gallery`);
      expect(publicGalleryAfter.status).to.equal(200);
      expect(publicGalleryAfter.text).to.include(`/event/${createdEvent.token}/media/${pendingFile.storedName}/original`);
    });

    it('permet a un utilisateur d\'activer, modifier, regenerer le token et supprimer son evenement', async () => {
      const agent = request.agent(app);
      const registerPage = await agent.get('/register');
      const registerCsrf = extractCsrfToken(registerPage.text);

      await agent
        .post('/register')
        .type('form')
        .send({
          _csrf: registerCsrf,
          fullName: 'Nina Event',
          email: 'nina@example.com',
          password: 'SecurePass123',
          confirmPassword: 'SecurePass123',
        })
        .expect(302);

      const profilePage = await agent.get('/profile');
      const profileCsrf = extractCsrfToken(profilePage.text);

      await agent
        .post('/profile/events')
        .type('form')
        .send({
          _csrf: profileCsrf,
          name: 'Atelier Photo',
          description: 'Atelier photo pour debutants et passionnes.',
          startsAt: '2026-07-01T14:00',
          status: 'inactive',
        })
        .expect(302);

      const owner = await userStore.findByEmail('nina@example.com');
      const events = await eventStore.listByOwner(owner.id);
      expect(events).to.have.lengthOf(1);
      const createdEvent = events[0];
      const oldToken = createdEvent.token;

      const refreshedProfile = await agent.get('/profile');
      const refreshedCsrf = extractCsrfToken(refreshedProfile.text);

      await agent
        .post(`/profile/events/${createdEvent.id}/activate`)
        .type('form')
        .send({ _csrf: refreshedCsrf })
        .expect(302);

      const activeEvent = await eventStore.findById(createdEvent.id);
      expect(activeEvent.status).to.equal('active');

      const editPage = await agent.get(`/profile/events/${createdEvent.id}/edit`);
      expect(editPage.status).to.equal(200);
      expect(editPage.text).to.include('Modifier un evenement');
      const editCsrf = extractCsrfToken(editPage.text);

      await agent
        .post(`/profile/events/${createdEvent.id}?_method=PUT`)
        .type('form')
        .send({
          _csrf: editCsrf,
          name: 'Atelier Photo Pro',
          description: 'Atelier photo avance avec session pratique.',
          startsAt: '2026-07-02T15:30',
          status: 'inactive',
          uploadSourceMode: 'camera_only',
          uploadAllowMultiple: '1',
        })
        .expect(302);

      const updatedEvent = await eventStore.findById(createdEvent.id);
      expect(updatedEvent.name).to.equal('Atelier Photo Pro');
      expect(updatedEvent.description).to.equal('Atelier photo avance avec session pratique.');
      expect(updatedEvent.status).to.equal('inactive');
      expect(updatedEvent.uploadSourceMode).to.equal('camera_only');
      expect(updatedEvent.uploadAllowMultiple).to.equal(true);

      const tokenPage = await agent.get(`/profile/events/${createdEvent.id}/edit`);
      const tokenCsrf = extractCsrfToken(tokenPage.text);

      await agent
        .post(`/profile/events/${createdEvent.id}/regenerate-token`)
        .type('form')
        .send({ _csrf: tokenCsrf })
        .expect(302);

      const regeneratedEvent = await eventStore.findById(createdEvent.id);
      expect(regeneratedEvent.token).to.match(/^[A-Za-z0-9]{10}$/);
      expect(regeneratedEvent.token).to.not.equal(oldToken);

      const deletePage = await agent.get('/profile');
      const deleteCsrf = extractCsrfToken(deletePage.text);

      await agent
        .post(`/profile/events/${createdEvent.id}?_method=DELETE`)
        .type('form')
        .send({ _csrf: deleteCsrf })
        .expect(302);

      const eventsAfterDelete = await eventStore.listByOwner(owner.id);
      expect(eventsAfterDelete).to.have.lengthOf(0);

      const eventStoragePath = path.join(EVENT_STORAGE_ROOT, createdEvent.uuid);
      expect(await pathExists(eventStoragePath)).to.equal(false);
    });
  });

  describe('Administration utilisateurs', () => {
    async function loginAsAdmin(agent) {
      const loginPage = await agent.get('/login');
      const csrfToken = extractCsrfToken(loginPage.text);

      await agent
        .post('/login')
        .type('form')
        .send({
          _csrf: csrfToken,
          email: 'admin@example.com',
          password: 'Admin1234',
        })
        .expect(302);
    }

    it('permet le CRUD complet des utilisateurs depuis l\'administration', async () => {
      const agent = request.agent(app);
      await loginAsAdmin(agent);

      const createPage = await agent.get('/admin/users/new');
      const createCsrfToken = extractCsrfToken(createPage.text);

      const createResponse = await agent
        .post('/admin/users')
        .type('form')
        .send({
          _csrf: createCsrfToken,
          fullName: 'Charlie Editor',
          email: 'charlie@example.com',
          role: 'user',
          status: 'active',
          password: 'StrongPass123',
        });

      expect(createResponse.status).to.equal(302);
      expect(createResponse.headers.location).to.equal('/admin');

      const createdUser = await userStore.findByEmail('charlie@example.com');
      expect(createdUser).to.not.equal(null);

      const editPage = await agent.get(`/admin/users/${createdUser.id}/edit`);
      const editCsrfToken = extractCsrfToken(editPage.text);

      const updateResponse = await agent
        .post(`/admin/users/${createdUser.id}?_method=PUT`)
        .type('form')
        .send({
          _csrf: editCsrfToken,
          fullName: 'Charlie Manager',
          email: 'charlie.manager@example.com',
          role: 'admin',
          status: 'active',
          password: '',
        });

      expect(updateResponse.status).to.equal(302);
      expect(updateResponse.headers.location).to.equal('/admin');

      const adminPage = await agent.get('/admin');
      expect(adminPage.status).to.equal(200);
      expect(adminPage.text).to.include('charlie.manager@example.com');
      expect(adminPage.text).to.include('Charlie Manager');

      const deleteCsrfToken = extractCsrfToken(adminPage.text);
      const updatedUser = await userStore.findByEmail('charlie.manager@example.com');

      const deleteResponse = await agent
        .post(`/admin/users/${updatedUser.id}?_method=DELETE`)
        .type('form')
        .send({
          _csrf: deleteCsrfToken,
        });

      expect(deleteResponse.status).to.equal(302);
      expect(deleteResponse.headers.location).to.equal('/admin');

      const deletedUser = await userStore.findByEmail('charlie.manager@example.com');
      expect(deletedUser).to.equal(null);
    });
  });

  describe('Administration evenements', () => {
    async function loginAsAdmin(agent) {
      const loginPage = await agent.get('/login');
      const csrfToken = extractCsrfToken(loginPage.text);

      await agent
        .post('/login')
        .type('form')
        .send({
          _csrf: csrfToken,
          email: 'admin@example.com',
          password: 'Admin1234',
        })
        .expect(302);
    }

    it('permet le CRUD des evenements depuis l\'administration', async () => {
      const agent = request.agent(app);
      await loginAsAdmin(agent);

      const adminUser = await userStore.findByEmail('admin@example.com');

      const createPage = await agent.get('/admin/events/new');
      const createCsrf = extractCsrfToken(createPage.text);

      const createResponse = await agent
        .post('/admin/events')
        .type('form')
        .send({
          _csrf: createCsrf,
          ownerUserId: String(adminUser.id),
          name: 'Soiree Admin',
          description: 'Soiree privee pour les administrateurs.',
          startsAt: '2026-06-10T20:00',
          status: 'inactive',
          uploadSourceMode: 'camera_only',
          uploadAllowMultiple: '1',
        });

      expect(createResponse.status).to.equal(302);
      expect(createResponse.headers.location).to.equal('/admin');

      const eventsAfterCreate = await eventStore.listAll();
      expect(eventsAfterCreate).to.have.lengthOf(1);
      const createdEvent = eventsAfterCreate[0];
      expect(createdEvent.name).to.equal('Soiree Admin');
      expect(createdEvent.description).to.equal('Soiree privee pour les administrateurs.');
      expect(createdEvent.uploadSourceMode).to.equal('camera_only');
      expect(createdEvent.uploadAllowMultiple).to.equal(true);

      const eventStoragePath = path.join(EVENT_STORAGE_ROOT, createdEvent.uuid);
      expect(await pathExists(eventStoragePath)).to.equal(true);

      const editPage = await agent.get(`/admin/events/${createdEvent.id}/edit`);
      const editCsrf = extractCsrfToken(editPage.text);

      const updateResponse = await agent
        .post(`/admin/events/${createdEvent.id}?_method=PUT`)
        .type('form')
        .send({
          _csrf: editCsrf,
          ownerUserId: String(adminUser.id),
          name: 'Soiree Admin VIP',
          description: 'Version VIP avec acces reserve.',
          startsAt: '2026-06-10T21:00',
          status: 'active',
          uploadSourceMode: 'library_only',
        });

      expect(updateResponse.status).to.equal(302);
      expect(updateResponse.headers.location).to.equal('/admin');

      const adminPage = await agent.get('/admin');
      expect(adminPage.status).to.equal(200);
      expect(adminPage.text).to.include('Soiree Admin VIP');

      const updatedEvent = await eventStore.findById(createdEvent.id);
      expect(updatedEvent.uploadSourceMode).to.equal('library_only');
      expect(updatedEvent.uploadAllowMultiple).to.equal(false);

      const beforeRegen = await eventStore.findById(createdEvent.id);
      const regenPage = await agent.get(`/admin/events/${createdEvent.id}/edit`);
      const regenCsrf = extractCsrfToken(regenPage.text);

      const regenResponse = await agent
        .post(`/admin/events/${createdEvent.id}/regenerate-token`)
        .type('form')
        .send({
          _csrf: regenCsrf,
        });

      expect(regenResponse.status).to.equal(302);
      expect(regenResponse.headers.location).to.equal(`/admin/events/${createdEvent.id}/edit`);

      const afterRegen = await eventStore.findById(createdEvent.id);
      expect(afterRegen.token).to.match(/^[A-Za-z0-9]{10}$/);
      expect(afterRegen.token).to.not.equal(beforeRegen.token);

      const deleteCsrf = extractCsrfToken(adminPage.text);
      const deleteResponse = await agent
        .post(`/admin/events/${createdEvent.id}?_method=DELETE`)
        .type('form')
        .send({
          _csrf: deleteCsrf,
        });

      expect(deleteResponse.status).to.equal(302);
      expect(deleteResponse.headers.location).to.equal('/admin');

      const eventsAfterDelete = await eventStore.listAll();
      expect(eventsAfterDelete).to.have.lengthOf(0);
      expect(await pathExists(eventStoragePath)).to.equal(false);
    });
  });

  describe('Mode degrade (DB indisponible)', () => {
    let previousDatabaseReady;

    beforeEach(() => {
      previousDatabaseReady = app.locals.databaseReady;
    });

    afterEach(() => {
      app.locals.databaseReady = previousDatabaseReady;
    });

    it('la page accueil reste accessible', async () => {
      app.locals.databaseReady = false;

      const res = await request(app).get('/');

      expect(res.status).to.equal(200);
      expect(res.text).to.include('Bienvenue sur PicPix');
    });

    it('les autres pages retournent 503', async () => {
      app.locals.databaseReady = false;

      const res = await request(app).get('/inconnu');

      expect(res.status).to.equal(503);
      expect(res.text).to.include('Service temporairement indisponible');
    });
  });
});
