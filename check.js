import argon2 from 'argon2';

async function hashValue(value) {
    try {
        const hash = await argon2.hash(value);
        return hash;
    } catch (err) {
        console.error('Hashing error:', err);
    }
}

async function runTest() {
    const input = "mySecretPassword";

    // Call function twice with same input
    const hash1 = await hashValue(input);
    const hash2 = await hashValue(input);

    console.log("Hash 1:", hash1);
    console.log("Hash 2:", hash2);

    // Compare hashes directly
    console.log("Are hashes equal?", hash1 === hash2);

    // Verify using argon2 (correct way)
    const verify1 = await argon2.verify(hash1, input);
    const verify2 = await argon2.verify(hash2, input);

    console.log("Hash1 valid?", verify1);
    console.log("Hash2 valid?", verify2);
}

runTest();




import crypto from 'crypto';

function hashValue(value) {
    return crypto
        .createHash('sha256')
        .update(value)
        .digest('hex');
}

function runTest() {
    const input = "mySecretPassword";

    // Hash same input twice
    const hash1 = hashValue(input);
    const hash2 = hashValue(input);

    console.log("Hash 1:", hash1);
    console.log("Hash 2:", hash2);

    console.log("Are hashes equal?", hash1 === hash2);
}

runTest();



