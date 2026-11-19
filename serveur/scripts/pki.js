'use strict';
// Crée l'autorité de certification privée, le certificat du serveur (WebSocket agent) et le certificat
// client de l'agent (mTLS).
//
//   npm run pki                                    -> localhost / 127.0.0.1 (développement)
//   npm run pki -- --domaine agent.mon-domaine.fr  -> + le nom public du serveur
//   npm run pki -- --force                         -> refait tout (l'agent devra recevoir les nouveaux fichiers)
//
// Fichiers créés :
//   serveur/pki/ca.crt.pem, ca.key.pem (la clé de l'autorité : à garder hors du serveur en production),
//   serveur/pki/serveur.crt.pem, serveur.key.pem
//   agent/secrets/ca.crt.pem, agent.crt.pem, agent.key.pem, empreinte_serveur.txt

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const forge = require('node-forge');

function cleRsa(bits = 3072) {
  // générée par Node (rapide), convertie pour node-forge
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const prive = forge.pki.privateKeyFromPem(privateKey);
  return { prive, publique: forge.pki.setRsaPublicKey(prive.n, prive.e), pem: privateKey };
}

function certificat({ cn, cle, emetteur, cleEmetteur, annees, ca = false, usage, domaines = [], ips = [] }) {
  const c = forge.pki.createCertificate();
  c.publicKey = cle.publique;
  c.serialNumber = `01${crypto.randomBytes(15).toString('hex')}`;
  c.validity.notBefore = new Date(Date.now() - 60e3);
  c.validity.notAfter = new Date(Date.now() + annees * 365 * 864e5);
  const sujet = [{ name: 'commonName', value: cn }, { name: 'organizationName', value: 'Imprimantes' }];
  c.setSubject(sujet);
  c.setIssuer(emetteur ? emetteur.subject.attributes : sujet);
  const ext = [
    { name: 'basicConstraints', cA: ca, ...(ca ? { pathLenConstraint: 0 } : {}), critical: true },
    { name: 'subjectKeyIdentifier' },
  ];
  if (ca) {
    ext.push({ name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true });
  } else {
    ext.push({ name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true });
    ext.push({ name: 'extKeyUsage', serverAuth: usage === 'serveur', clientAuth: usage === 'client' });
    if (usage === 'serveur') {
      ext.push({ name: 'subjectAltName', altNames: [
        ...domaines.map((value) => ({ type: 2, value })), ...ips.map((ip) => ({ type: 7, ip })),
      ] });
    }
  }
  c.setExtensions(ext);
  c.sign(cleEmetteur || cle.prive, forge.md.sha256.create());
  return c;
}

// signe un certificat client avec une autorité existante (utilisé aussi par les tests)
function certificatClient({ caCertPem, caClePem, cn, bits = 2048 }) {
  const cle = cleRsa(bits);
  const ca = forge.pki.certificateFromPem(caCertPem);
  const c = certificat({ cn, cle, emetteur: ca, cleEmetteur: forge.pki.privateKeyFromPem(caClePem), annees: 1, usage: 'client' });
  return { cert: forge.pki.certificateToPem(c), cle: cle.pem };
}

function genererPki({ fichiersServeur, dossierAgent, agentId, domaines = ['localhost'], ips = ['127.0.0.1'], bits = 3072 }) {
  const ecrire = (f, contenu) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, contenu, { mode: 0o600 }); };

  const cleCa = cleRsa(bits);
  const ca = certificat({ cn: 'Imprimantes - autorite privee', cle: cleCa, annees: 10, ca: true });
  const caPem = forge.pki.certificateToPem(ca);
  const cleSrv = cleRsa(bits);
  const srvPem = forge.pki.certificateToPem(certificat({ cn: domaines.at(-1), cle: cleSrv, emetteur: ca,
    cleEmetteur: cleCa.prive, annees: 2, usage: 'serveur', domaines, ips }));
  const cleAgent = cleRsa(bits);
  const agentPem = forge.pki.certificateToPem(certificat({ cn: agentId, cle: cleAgent, emetteur: ca,
    cleEmetteur: cleCa.prive, annees: 2, usage: 'client' }));

  ecrire(fichiersServeur.ca, caPem);
  ecrire(path.join(path.dirname(fichiersServeur.ca), 'ca.key.pem'), cleCa.pem);
  ecrire(fichiersServeur.cert, srvPem);
  ecrire(fichiersServeur.cle, cleSrv.pem);
  ecrire(path.join(dossierAgent, 'ca.crt.pem'), caPem);
  ecrire(path.join(dossierAgent, 'agent.crt.pem'), agentPem);
  ecrire(path.join(dossierAgent, 'agent.key.pem'), cleAgent.pem);
  const empreinte = crypto.createHash('sha256').update(new crypto.X509Certificate(srvPem).raw).digest('hex');
  ecrire(path.join(dossierAgent, 'empreinte_serveur.txt'), `${empreinte}\n`);
  return { empreinte, caPem, caCle: cleCa.pem };
}

module.exports = { genererPki, certificatClient };

if (require.main === module) {
  const { charger, RACINE } = require('../src/config');
  const args = process.argv.slice(2);
  const option = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : null; };
  const config = charger();
  if (fs.existsSync(config.pki.cert) && !args.includes('--force')) {
    console.error('Les certificats existent déjà. Ajoute --force pour tout refaire.');
    process.exit(1);
  }
  const domaines = ['localhost', ...String(option('--domaine') || '').split(',').filter(Boolean)];
  const ips = ['127.0.0.1', ...String(option('--ip') || '').split(',').filter(Boolean)];
  const dossierAgent = path.resolve(RACINE, '..', 'agent', 'secrets');
  const { empreinte } = genererPki({ fichiersServeur: config.pki, dossierAgent, agentId: config.agent.id, domaines, ips });
  console.log(`Autorité, certificat serveur (${domaines.join(', ')} / ${ips.join(', ')}) et certificat agent (CN=${config.agent.id}) créés.`);
  console.log(`Empreinte du certificat serveur : ${empreinte}`);
  console.log(`Fichiers de l'agent : ${dossierAgent}`);
  console.log('Prochaine étape : python agent/agent.py --generer-cle, puis npm run agent:enroler -- ../agent/secrets/agent_ed25519.pub.pem');
}
