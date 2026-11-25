import dns from 'node:dns';
import mongoose from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectDatabase,
  disconnectDatabase,
  getDatabaseStatus,
  isDatabaseReady
} from '../../src/config/database.js';
import { LOG_FORMATS, createLogger } from '../../src/utils/logger.js';

describe('Database lifecycle, DNS fallback logging, and cleanup (unit / mocked Mongoose)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('connects with bounded timeouts and disconnects cleanly', async () => {
    const logger = createLogger({ level: 'silent' });
    const connectSpy = vi.spyOn(mongoose, 'connect').mockResolvedValue(mongoose);
    const disconnectSpy = vi.spyOn(mongoose, 'disconnect').mockResolvedValue();

    await connectDatabase('mongodb://user:pass@127.0.0.1:27017/c2c_mock', { logger });

    expect(connectSpy).toHaveBeenCalledWith(
      'mongodb://user:pass@127.0.0.1:27017/c2c_mock',
      expect.objectContaining({
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        maxPoolSize: 25
      })
    );

    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    expect(isDatabaseReady()).toBe(true);
    expect(getDatabaseStatus().stateLabel).toBe('connected');

    await disconnectDatabase({ logger });
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects safely without exposing credentials when connection fails', async () => {
    const logger = createLogger({ level: 'silent' });
    const errorSpy = vi.spyOn(logger, 'error');
    vi.spyOn(mongoose, 'connect').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      connectDatabase('mongodb+srv://secretUser:secretPass@cluster.example.net/db', {
        logger
      })
    ).rejects.toThrow('ECONNREFUSED');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'mongodb+srv://[REDACTED]@cluster.example.net/db'
      }),
      'Failed to connect to MongoDB'
    );
  });

  it('distinguishes recoverable DNS SRV fallback from final connection failure', async () => {
    const logger = createLogger({ level: 'info', format: LOG_FORMATS.MINIMAL });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const successSpy = vi.spyOn(logger, 'success').mockImplementation(() => {});

    const srvErr = Object.assign(new Error('querySrv ECONNREFUSED _mongodb._tcp.c.net'), {
      code: 'ECONNREFUSED',
      syscall: 'querySrv'
    });

    vi.spyOn(dns, 'getServers').mockReturnValue(['127.0.0.1']);
    const setServersSpy = vi.spyOn(dns, 'setServers').mockImplementation(() => {});
    const connectSpy = vi
      .spyOn(mongoose, 'connect')
      .mockRejectedValueOnce(srvErr)
      .mockResolvedValueOnce(mongoose);

    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await connectDatabase('mongodb+srv://user:pass@cluster.example.net/db', {
        logger,
        allowDnsFallback: true
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }

    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(setServersSpy).toHaveBeenCalledWith(['1.1.1.1', '8.8.8.8']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledTimes(1);
  });
});
