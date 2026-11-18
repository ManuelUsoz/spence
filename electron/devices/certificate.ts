// @peculiar/x509 resolves its parsers through tsyringe, which needs the Reflect metadata polyfill loaded first.
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { Effect } from 'effect';
import { webcrypto, X509Certificate } from 'node:crypto';

/** A Device's self-signed TLS certificate and its private key, both PEM. */
export interface DeviceCertificate {
  readonly certificate: string;
  readonly privateKey: string;
}

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
/** Long enough never to expire under a user: the fingerprint, not the dates, is what other Devices trust. */
const VALID_YEARS = 30;

// @types/node and the DOM lib disagree on the KeyUsage list (`decapsulateBits`); the objects are the same.
const crypto = webcrypto as unknown as Crypto;
x509.cryptoProvider.set(crypto);

/**
 * Makes the Device's one self-signed certificate (ECDSA P-256), carrying its id in the subject. It is its own CA
 * (`cA`, `keyCertSign`), so a Paired device can pin it as the only trusted root and keep certificate verification on.
 */
export const generateCertificate = (deviceId: string): Effect.Effect<DeviceCertificate> =>
  Effect.promise(async () => {
    const keys = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
    const notBefore = new Date();
    const notAfter = new Date(notBefore);
    notAfter.setFullYear(notBefore.getFullYear() + VALID_YEARS);
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: Buffer.from(webcrypto.getRandomValues(new Uint8Array(8))).toString('hex'),
      name: `CN=Spence ${deviceId}`,
      notBefore,
      notAfter,
      signingAlgorithm: ALGORITHM,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, undefined, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.digitalSignature,
          true,
        ),
      ],
    });
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', keys.privateKey);
    return {
      certificate: certificate.toString('pem'),
      privateKey: x509.PemConverter.encode(pkcs8, 'PRIVATE KEY'),
    };
  });

/**
 * The SHA-256 fingerprint of a PEM certificate, in the `AB:CD:…` form `node:tls` reports as `fingerprint256`.
 * It is the trust anchor between Devices, never the address.
 */
export const fingerprintOf = (certificate: string): string =>
  new X509Certificate(certificate).fingerprint256;
