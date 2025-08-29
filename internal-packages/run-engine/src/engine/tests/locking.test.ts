import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { RunLocker, LockAcquisitionTimeoutError } from "../locking.js";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";

describe("RunLocker", () => {
  redisTest("Test acquiring a lock works", { timeout: 15_000 }, async ({ redisOptions }) => {
    const redis = createRedisClient(redisOptions);
    const logger = new Logger("RunLockTest", "debug");
    const runLock = new RunLocker({
      redis,
      logger,
      tracer: trace.getTracer("RunLockTest"),
    });

    try {
      expect(runLock.isInsideLock()).toBe(false);

      await runLock.lock("test-lock", ["test-1"], async () => {
        expect(runLock.isInsideLock()).toBe(true);
      });

      expect(runLock.isInsideLock()).toBe(false);
    } finally {
      await runLock.quit();
    }
  });

  redisTest("Test double locking works", { timeout: 15_000 }, async ({ redisOptions }) => {
    const redis = createRedisClient(redisOptions);
    const logger = new Logger("RunLockTest", "debug");
    const runLock = new RunLocker({ redis, logger, tracer: trace.getTracer("RunLockTest") });

    try {
      expect(runLock.isInsideLock()).toBe(false);

      await runLock.lock("test-lock", ["test-1"], async () => {
        expect(runLock.isInsideLock()).toBe(true);

        //should be able to "lock it again"
        await runLock.lock("test-lock", ["test-1"], async () => {
          expect(runLock.isInsideLock()).toBe(true);
        });
      });

      expect(runLock.isInsideLock()).toBe(false);
    } finally {
      await runLock.quit();
    }
  });

  redisTest(
    "Test lock throws when callback throws",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");
      const runLock = new RunLocker({ redis, logger, tracer: trace.getTracer("RunLockTest") });

      try {
        expect(runLock.isInsideLock()).toBe(false);

        await expect(
          runLock.lock("test-lock", ["test-1"], async () => {
            throw new Error("Test error");
          })
        ).rejects.toThrow("Test error");

        // Verify the lock was released
        expect(runLock.isInsideLock()).toBe(false);
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest(
    "Test nested lock throws when inner callback throws",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");
      const runLock = new RunLocker({ redis, logger, tracer: trace.getTracer("RunLockTest") });

      try {
        expect(runLock.isInsideLock()).toBe(false);

        await expect(
          runLock.lock("test-lock", ["test-1"], async () => {
            expect(runLock.isInsideLock()).toBe(true);

            // Nested lock with same resource
            await runLock.lock("test-lock", ["test-1"], async () => {
              expect(runLock.isInsideLock()).toBe(true);
              throw new Error("Inner lock error");
            });
          })
        ).rejects.toThrow("Inner lock error");

        // Verify all locks were released
        expect(runLock.isInsideLock()).toBe(false);
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest("Test lock throws when it times out", { timeout: 45_000 }, async ({ redisOptions }) => {
    const redis = createRedisClient(redisOptions);
    const logger = new Logger("RunLockTest", "debug");
    const runLock = new RunLocker({
      redis,
      logger,
      tracer: trace.getTracer("RunLockTest"),
      retryConfig: {
        maxAttempts: 3,
        baseDelay: 100,
        maxTotalWaitTime: 2000, // 2 second timeout for faster test
      },
    });

    try {
      // First, ensure we can acquire the lock normally
      let firstLockAcquired = false;
      await runLock.lock("test-lock", ["test-1"], async () => {
        firstLockAcquired = true;
      });
      //wait for 20ms
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(firstLockAcquired).toBe(true);

      // Now create a long-running lock
      const lockPromise1 = runLock.lock("test-lock", ["test-1"], async () => {
        // Hold the lock longer than the retry timeout
        await new Promise((resolve) => setTimeout(resolve, 10000));
      });

      // Try to acquire same lock immediately - should timeout with LockAcquisitionTimeoutError
      await expect(
        runLock.lock("test-lock", ["test-1"], async () => {
          // This should never execute
          expect(true).toBe(false);
        })
      ).rejects.toThrow(LockAcquisitionTimeoutError);

      // Complete the first lock
      await lockPromise1;

      // Verify final state
      expect(runLock.isInsideLock()).toBe(false);
    } finally {
      await runLock.quit();
    }
  });

  redisTest(
    "Test nested lock with same resources doesn't timeout",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");
      const runLock = new RunLocker({ redis, logger, tracer: trace.getTracer("RunLockTest") });

      try {
        await runLock.lock("test-lock", ["test-1"], async () => {
          // First lock acquired
          expect(runLock.isInsideLock()).toBe(true);

          // Try to acquire the same resource with a very short timeout
          // This should work because we already hold the lock
          await runLock.lock("test-lock", ["test-1"], async () => {
            expect(runLock.isInsideLock()).toBe(true);
            // Wait longer than the timeout to prove it doesn't matter
            await new Promise((resolve) => setTimeout(resolve, 500));
          });
        });

        // Verify final state
        expect(runLock.isInsideLock()).toBe(false);
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest(
    "Test nested lock with same resource works regardless of retries",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");
      const runLock = new RunLocker({ redis, logger, tracer: trace.getTracer("RunLockTest") });

      try {
        // First verify we can acquire the lock normally
        let firstLockAcquired = false;
        await runLock.lock("test-lock", ["test-1"], async () => {
          firstLockAcquired = true;
        });
        expect(firstLockAcquired).toBe(true);

        // Now test the nested lock behavior
        let outerLockExecuted = false;
        let innerLockExecuted = false;

        await runLock.lock("test-lock", ["test-1"], async () => {
          outerLockExecuted = true;
          expect(runLock.isInsideLock()).toBe(true);
          expect(runLock.getCurrentResources()).toBe("test-1");

          // Try to acquire the same resource in a nested lock
          // This should work immediately without any retries
          // because we already hold the lock
          await runLock.lock("test-lock", ["test-1"], async () => {
            innerLockExecuted = true;
            expect(runLock.isInsideLock()).toBe(true);
            expect(runLock.getCurrentResources()).toBe("test-1");

            // Sleep longer than retry attempts would normally take
            // This proves the nested lock doesn't go through the retry logic
            await new Promise((resolve) => setTimeout(resolve, 5000));
          });
        });

        // Verify both locks executed
        expect(outerLockExecuted).toBe(true);
        expect(innerLockExecuted).toBe(true);
        expect(runLock.isInsideLock()).toBe(false);
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest(
    "Test configurable retry settings work",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");
      const runLock = new RunLocker({
        redis,
        logger,
        tracer: trace.getTracer("RunLockTest"),
        retryConfig: {
          maxAttempts: 2,
          baseDelay: 50,
          maxDelay: 200,
          backoffMultiplier: 2.0,
          jitterFactor: 0.1,
          maxTotalWaitTime: 1000,
        },
      });

      try {
        // Verify configuration is set correctly
        const config = runLock.getRetryConfig();
        expect(config.maxAttempts).toBe(2);
        expect(config.baseDelay).toBe(50);
        expect(config.maxDelay).toBe(200);
        expect(config.backoffMultiplier).toBe(2.0);
        expect(config.jitterFactor).toBe(0.1);
        expect(config.maxTotalWaitTime).toBe(1000);

        // Test that the lock still works normally
        await runLock.lock("test-lock", ["test-config"], async () => {
          expect(runLock.isInsideLock()).toBe(true);
        });

        expect(runLock.isInsideLock()).toBe(false);
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest(
    "Test LockAcquisitionTimeoutError contains correct information",
    { timeout: 25_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");
      const runLock = new RunLocker({
        redis,
        logger,
        tracer: trace.getTracer("RunLockTest"),
        retryConfig: {
          maxAttempts: 2,
          baseDelay: 50,
          maxTotalWaitTime: 500, // Shorter timeout to ensure failure
        },
      });

      try {
        // Create a long-running lock that will definitely outlast the retry timeout
        const lockPromise = runLock.lock("test-lock", ["test-error"], async () => {
          await new Promise((resolve) => setTimeout(resolve, 15000)); // Hold for 15 seconds
        });

        // Wait a bit to ensure the first lock is acquired
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Try to acquire same lock and capture the timeout error
        try {
          await runLock.lock("test-lock", ["test-error"], async () => {
            expect(true).toBe(false); // Should never execute
          });
          expect(true).toBe(false); // Should not reach here
        } catch (error) {
          expect(error).toBeInstanceOf(LockAcquisitionTimeoutError);

          if (error instanceof LockAcquisitionTimeoutError) {
            expect(error.resources).toEqual(["test-error"]);
            expect(error.attempts).toBeGreaterThan(0);
            expect(error.attempts).toBeLessThanOrEqual(3); // maxAttempts + 1
            expect(error.totalWaitTime).toBeGreaterThan(0);
            expect(error.totalWaitTime).toBeLessThanOrEqual(800); // Some tolerance
            expect(error.name).toBe("LockAcquisitionTimeoutError");
            expect(error.message).toContain("test-error");
            expect(error.message).toContain(`${error.attempts} attempts`);
          }
        }

        // Complete the first lock
        await lockPromise;
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest("Test default configuration values", { timeout: 15_000 }, async ({ redisOptions }) => {
    const redis = createRedisClient(redisOptions);
    const logger = new Logger("RunLockTest", "debug");
    const runLock = new RunLocker({
      redis,
      logger,
      tracer: trace.getTracer("RunLockTest"),
      // No retryConfig provided - should use defaults
    });

    try {
      const config = runLock.getRetryConfig();
      expect(config.maxAttempts).toBe(10);
      expect(config.baseDelay).toBe(200);
      expect(config.maxDelay).toBe(5000);
      expect(config.backoffMultiplier).toBe(1.5);
      expect(config.jitterFactor).toBe(0.1);
      expect(config.maxTotalWaitTime).toBe(30000);

      // Test that it still works
      await runLock.lock("test-lock", ["test-default"], async () => {
        expect(runLock.isInsideLock()).toBe(true);
      });
    } finally {
      await runLock.quit();
    }
  });

  redisTest(
    "Test partial configuration override",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");
      const runLock = new RunLocker({
        redis,
        logger,
        tracer: trace.getTracer("RunLockTest"),
        retryConfig: {
          maxAttempts: 5,
          maxTotalWaitTime: 10000,
          // Other values should use defaults
        },
      });

      try {
        const config = runLock.getRetryConfig();
        expect(config.maxAttempts).toBe(5); // Overridden
        expect(config.maxTotalWaitTime).toBe(10000); // Overridden
        expect(config.baseDelay).toBe(200); // Default
        expect(config.maxDelay).toBe(5000); // Default
        expect(config.backoffMultiplier).toBe(1.5); // Default
        expect(config.jitterFactor).toBe(0.1); // Default
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest("Test lockIf functionality", { timeout: 15_000 }, async ({ redisOptions }) => {
    const redis = createRedisClient(redisOptions);
    const logger = new Logger("RunLockTest", "debug");
    const runLock = new RunLocker({
      redis,
      logger,
      tracer: trace.getTracer("RunLockTest"),
    });

    try {
      let executedWithLock = false;
      let executedWithoutLock = false;

      // Test with condition = true (should acquire lock)
      await runLock.lockIf(true, "test-lock", ["test-lockif"], async () => {
        executedWithLock = true;
        expect(runLock.isInsideLock()).toBe(true);
        expect(runLock.getCurrentResources()).toBe("test-lockif");
      });

      expect(executedWithLock).toBe(true);
      expect(runLock.isInsideLock()).toBe(false);

      // Test with condition = false (should not acquire lock)
      await runLock.lockIf(false, "test-lock", ["test-lockif"], async () => {
        executedWithoutLock = true;
        expect(runLock.isInsideLock()).toBe(false);
        expect(runLock.getCurrentResources()).toBeUndefined();
      });

      expect(executedWithoutLock).toBe(true);
    } finally {
      await runLock.quit();
    }
  });

  redisTest(
    "Test concurrent locks on different resources",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");
      const runLock = new RunLocker({
        redis,
        logger,
        tracer: trace.getTracer("RunLockTest"),
      });

      try {
        const results: string[] = [];

        // Start multiple concurrent locks on different resources
        const lock1Promise = runLock.lock("test-lock", ["resource-1"], async () => {
          results.push("lock1-start");
          await new Promise((resolve) => setTimeout(resolve, 100));
          results.push("lock1-end");
          return "result1";
        });

        const lock2Promise = runLock.lock("test-lock", ["resource-2"], async () => {
          results.push("lock2-start");
          await new Promise((resolve) => setTimeout(resolve, 100));
          results.push("lock2-end");
          return "result2";
        });

        const lock3Promise = runLock.lock("test-lock", ["resource-3"], async () => {
          results.push("lock3-start");
          await new Promise((resolve) => setTimeout(resolve, 100));
          results.push("lock3-end");
          return "result3";
        });

        const [result1, result2, result3] = await Promise.all([
          lock1Promise,
          lock2Promise,
          lock3Promise,
        ]);

        expect(result1).toBe("result1");
        expect(result2).toBe("result2");
        expect(result3).toBe("result3");

        // All locks should have started (concurrent execution)
        expect(results).toContain("lock1-start");
        expect(results).toContain("lock2-start");
        expect(results).toContain("lock3-start");
        expect(results).toContain("lock1-end");
        expect(results).toContain("lock2-end");
        expect(results).toContain("lock3-end");
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest(
    "Test multiple resources in single lock",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");
      const runLock = new RunLocker({
        redis,
        logger,
        tracer: trace.getTracer("RunLockTest"),
      });

      try {
        await runLock.lock("test-lock", ["resource-a", "resource-b", "resource-c"], async () => {
          expect(runLock.isInsideLock()).toBe(true);
          // Resources should be sorted and joined
          expect(runLock.getCurrentResources()).toBe("resource-a,resource-b,resource-c");
        });

        // Test that resource order doesn't matter (should be normalized)
        await runLock.lock("test-lock", ["resource-c", "resource-a", "resource-b"], async () => {
          expect(runLock.getCurrentResources()).toBe("resource-a,resource-b,resource-c");
        });
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest(
    "Test different lock names on same resources don't interfere",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");
      const runLock = new RunLocker({
        redis,
        logger,
        tracer: trace.getTracer("RunLockTest"),
      });

      try {
        const results: string[] = [];

        // These should be able to run concurrently despite same resources
        // because they have different lock names
        const promise1 = runLock.lock("lock-type-1", ["shared-resource"], async () => {
          results.push("type1-start");
          await new Promise((resolve) => setTimeout(resolve, 200));
          results.push("type1-end");
        });

        const promise2 = runLock.lock("lock-type-2", ["shared-resource"], async () => {
          results.push("type2-start");
          await new Promise((resolve) => setTimeout(resolve, 200));
          results.push("type2-end");
        });

        await Promise.all([promise1, promise2]);

        // Both should have executed (different lock names don't block each other)
        expect(results).toContain("type1-start");
        expect(results).toContain("type1-end");
        expect(results).toContain("type2-start");
        expect(results).toContain("type2-end");
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest(
    "Test default duration configuration",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");

      // Test with custom default duration
      const runLock = new RunLocker({
        redis,
        logger,
        tracer: trace.getTracer("RunLockTest"),
        duration: 8000,
      });

      try {
        // Test that the default duration is set correctly
        expect(runLock.getDuration()).toBe(8000);

        // Test lock without specifying duration (should use default)
        const startTime = Date.now();
        await runLock.lock("test-lock", ["default-duration-test"], async () => {
          expect(runLock.isInsideLock()).toBe(true);
          // Sleep for a bit to ensure the lock is working
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        const elapsed = Date.now() - startTime;
        expect(elapsed).toBeGreaterThan(90); // Should have completed successfully

        // Test lockIf without duration (should use default)
        await runLock.lockIf(true, "test-lock", ["lockif-default"], async () => {
          expect(runLock.isInsideLock()).toBe(true);
        });
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest(
    "Test automatic extension threshold configuration",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");

      // Test with custom automatic extension threshold
      const runLock = new RunLocker({
        redis,
        logger,
        tracer: trace.getTracer("RunLockTest"),
        automaticExtensionThreshold: 200, // Custom threshold
        duration: 800,
      });

      try {
        // Test that the threshold is set correctly
        expect(runLock.getAutomaticExtensionThreshold()).toBe(200);
        expect(runLock.getDuration()).toBe(800); // Should use configured value

        // Test lock extension with custom threshold
        // Use a short lock duration but longer operation to trigger extension
        await runLock.lock("test-lock", ["extension-threshold-test"], async () => {
          expect(runLock.isInsideLock()).toBe(true);
          // Sleep longer than lock duration to ensure extension works
          await new Promise((resolve) => setTimeout(resolve, 1200));
        });
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest("Test Redlock retry configuration", { timeout: 10_000 }, async ({ redisOptions }) => {
    const redis = createRedisClient(redisOptions);
    const logger = new Logger("RunLockTest", "debug");

    // Test that we can configure all settings
    const runLock = new RunLocker({
      redis,
      logger,
      tracer: trace.getTracer("RunLockTest"),
      duration: 3000,
      automaticExtensionThreshold: 300,
      retryConfig: {
        maxAttempts: 5,
        baseDelay: 150,
      },
    });

    try {
      // Verify all configurations are set
      expect(runLock.getDuration()).toBe(3000);
      expect(runLock.getAutomaticExtensionThreshold()).toBe(300);

      const retryConfig = runLock.getRetryConfig();
      expect(retryConfig.maxAttempts).toBe(5);
      expect(retryConfig.baseDelay).toBe(150);

      // Test basic functionality with all custom configs
      await runLock.lock("test-lock", ["all-config-test"], async () => {
        expect(runLock.isInsideLock()).toBe(true);
      });
    } finally {
      await runLock.quit();
    }
  });

  redisTest(
    "Test production-optimized configuration",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");

      // Test with production-optimized settings (similar to RunEngine)
      const runLock = new RunLocker({
        redis,
        logger,
        tracer: trace.getTracer("RunLockTest"),
        duration: 10000,
        automaticExtensionThreshold: 2000,
        retryConfig: {
          maxAttempts: 15,
          baseDelay: 100,
          maxDelay: 3000,
          backoffMultiplier: 1.8,
          jitterFactor: 0.15,
          maxTotalWaitTime: 25000,
        },
      });

      try {
        // Verify production configuration
        expect(runLock.getDuration()).toBe(10000);
        expect(runLock.getAutomaticExtensionThreshold()).toBe(2000);

        const retryConfig = runLock.getRetryConfig();
        expect(retryConfig.maxAttempts).toBe(15);
        expect(retryConfig.baseDelay).toBe(100);
        expect(retryConfig.maxDelay).toBe(3000);
        expect(retryConfig.backoffMultiplier).toBe(1.8);
        expect(retryConfig.jitterFactor).toBe(0.15);
        expect(retryConfig.maxTotalWaitTime).toBe(25000);

        // Test lock with default duration (should use 10 seconds)
        const startTime = Date.now();
        await runLock.lock("test-lock", ["production-config"], async () => {
          expect(runLock.isInsideLock()).toBe(true);
          // Simulate a typical operation duration
          await new Promise((resolve) => setTimeout(resolve, 200));
        });
        const elapsed = Date.now() - startTime;
        expect(elapsed).toBeGreaterThan(190);
        expect(elapsed).toBeLessThan(1000); // Should complete quickly for successful operation
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest("Test configuration edge cases", { timeout: 15_000 }, async ({ redisOptions }) => {
    const logger = new Logger("RunLockTest", "debug");

    // Test with maxAttempts = 0
    const redis1 = createRedisClient(redisOptions);
    const runLock1 = new RunLocker({
      redis: redis1,
      logger,
      tracer: trace.getTracer("RunLockTest"),
      retryConfig: {
        maxAttempts: 0,
        baseDelay: 100,
        maxTotalWaitTime: 1000,
      },
    });

    try {
      const config = runLock1.getRetryConfig();
      expect(config.maxAttempts).toBe(0);

      // Should work for successful acquisitions
      await runLock1.lock("test-lock", ["test-edge"], async () => {
        expect(runLock1.isInsideLock()).toBe(true);
      });
    } finally {
      await runLock1.quit();
    }

    // Test with very small delays
    const redis2 = createRedisClient(redisOptions);
    const runLock2 = new RunLocker({
      redis: redis2,
      logger,
      tracer: trace.getTracer("RunLockTest"),
      retryConfig: {
        maxAttempts: 2,
        baseDelay: 1,
        maxDelay: 10,
        backoffMultiplier: 2.0,
        jitterFactor: 0.5,
        maxTotalWaitTime: 100,
      },
    });

    try {
      const config = runLock2.getRetryConfig();
      expect(config.baseDelay).toBe(1);
      expect(config.maxDelay).toBe(10);
      expect(config.jitterFactor).toBe(0.5);

      await runLock2.lock("test-lock", ["test-small"], async () => {
        expect(runLock2.isInsideLock()).toBe(true);
      });
    } finally {
      await runLock2.quit();
    }
  });

  redisTest("Test total wait time configuration", { timeout: 10_000 }, async ({ redisOptions }) => {
    const redis = createRedisClient(redisOptions);
    const logger = new Logger("RunLockTest", "debug");
    const runLock = new RunLocker({
      redis,
      logger,
      tracer: trace.getTracer("RunLockTest"),
      retryConfig: {
        maxAttempts: 100, // High retry count
        baseDelay: 100,
        maxTotalWaitTime: 500, // But low total wait time
      },
    });

    try {
      // Test that total wait time configuration is properly applied
      const config = runLock.getRetryConfig();
      expect(config.maxAttempts).toBe(100);
      expect(config.maxTotalWaitTime).toBe(500);
      expect(config.baseDelay).toBe(100);

      // Basic functionality test with the configuration
      await runLock.lock("test-lock", ["test-timing-config"], async () => {
        expect(runLock.isInsideLock()).toBe(true);
      });

      expect(runLock.isInsideLock()).toBe(false);
    } finally {
      await runLock.quit();
    }
  });

  redisTest(
    "Test quit functionality and cleanup",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");
      const runLock = new RunLocker({
        redis,
        logger,
        tracer: trace.getTracer("RunLockTest"),
      });

      // Acquire some locks to create state
      await runLock.lock("test-lock", ["quit-test-1"], async () => {
        expect(runLock.isInsideLock()).toBe(true);
      });

      // Verify we can still acquire locks
      await runLock.lock("test-lock", ["quit-test-2"], async () => {
        expect(runLock.isInsideLock()).toBe(true);
      });

      // Now quit should clean everything up
      await runLock.quit();

      // After quit, should be able to create new instance and acquire locks
      const newRedis = createRedisClient(redisOptions);
      const newRunLock = new RunLocker({
        redis: newRedis,
        logger,
        tracer: trace.getTracer("RunLockTest"),
      });

      try {
        await newRunLock.lock("test-lock", ["quit-test-1"], async () => {
          expect(newRunLock.isInsideLock()).toBe(true);
        });
      } finally {
        await newRunLock.quit();
      }
    }
  );

  redisTest(
    "Test lock extension during long operations",
    { timeout: 20_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");
      const runLock = new RunLocker({
        redis,
        logger,
        tracer: trace.getTracer("RunLockTest"),
        duration: 1000,
      });

      try {
        let lockExtended = false;
        const startTime = Date.now();

        // Acquire lock with short duration but long operation
        await runLock.lock("test-lock", ["extension-test"], async () => {
          // Operation longer than lock duration - should trigger extension
          await new Promise((resolve) => setTimeout(resolve, 2500));

          const elapsed = Date.now() - startTime;
          expect(elapsed).toBeGreaterThan(2000);

          // If we get here, extension must have worked
          lockExtended = true;
        });

        expect(lockExtended).toBe(true);
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest(
    "Test getCurrentResources in various states",
    { timeout: 15_000 },
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");
      const runLock = new RunLocker({
        redis,
        logger,
        tracer: trace.getTracer("RunLockTest"),
      });

      try {
        // Outside any lock
        expect(runLock.getCurrentResources()).toBeUndefined();
        expect(runLock.isInsideLock()).toBe(false);

        await runLock.lock("test-lock", ["resource-x", "resource-y"], async () => {
          // Inside lock
          expect(runLock.getCurrentResources()).toBe("resource-x,resource-y");
          expect(runLock.isInsideLock()).toBe(true);

          await runLock.lock("test-lock", ["resource-x", "resource-y"], async () => {
            // Nested lock with same resources
            expect(runLock.getCurrentResources()).toBe("resource-x,resource-y");
            expect(runLock.isInsideLock()).toBe(true);
          });
        });

        // Outside lock again
        expect(runLock.getCurrentResources()).toBeUndefined();
        expect(runLock.isInsideLock()).toBe(false);
      } finally {
        await runLock.quit();
      }
    }
  );

  redisTest(
    "Test retry behavior with exact timing",
    { timeout: 25_000 },
    async ({ redisOptions }) => {
      const redis1 = createRedisClient(redisOptions);
      const redis2 = createRedisClient(redisOptions);
      const logger = new Logger("RunLockTest", "debug");

      const runLock1 = new RunLocker({
        redis: redis1,
        logger,
        tracer: trace.getTracer("RunLockTest"),
      });

      const runLock2 = new RunLocker({
        redis: redis2,
        logger,
        tracer: trace.getTracer("RunLockTest"),
        duration: 30000,
        retryConfig: {
          maxAttempts: 3,
          baseDelay: 100,
          maxDelay: 500,
          backoffMultiplier: 2.0,
          jitterFactor: 0, // No jitter for predictable timing
          maxTotalWaitTime: 10000,
        },
      });

      try {
        // Create blocking lock with first instance - make it last much longer than retry logic
        const blockingPromise = runLock1.lock("test-lock", ["timing-test"], async () => {
          await new Promise((resolve) => setTimeout(resolve, 15000));
        });

        await new Promise((resolve) => setTimeout(resolve, 200));

        const startTime = Date.now();
        try {
          await runLock2.lock("test-lock", ["timing-test"], async () => {
            expect(true).toBe(false);
          });
          expect(true).toBe(false); // Should not reach here
        } catch (error) {
          const elapsed = Date.now() - startTime;
          expect(error).toBeInstanceOf(LockAcquisitionTimeoutError);

          if (error instanceof LockAcquisitionTimeoutError) {
            expect(error.attempts).toBe(4); // 0 + 3 retries
            // With backoff: 100ms + 200ms + 400ms = 700ms total wait time
            expect(error.totalWaitTime).toBeGreaterThan(600);
            expect(error.totalWaitTime).toBeLessThan(800);
            expect(elapsed).toBeGreaterThan(600);
          }
        }

        await blockingPromise;
      } finally {
        await runLock1.quit();
        await runLock2.quit();
      }
    }
  );
});
