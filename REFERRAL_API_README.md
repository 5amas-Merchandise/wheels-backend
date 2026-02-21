# Wheela Referral System API Guide

This document explains the referral system endpoints and logic for frontend/mobile app developers.

## Overview
- Every user gets a unique 8-character referral code on signup.
- Users can share their code with friends.
- When a friend signs up with the code and completes their first trip, both users receive wallet rewards.

## Key Concepts
- **referralCode**: Unique code for each user, shown in their profile.
- **usedReferralCode**: Code used by a new user during signup.
- **hasCompletedFirstTrip**: Boolean flag on user, set true after their first trip.
- **Referral Document**: Tracks referral relationship and reward status.

## API Endpoints

### 1. Get My Referral Code
- **GET /referrals/my-code**
- Returns the user's referral code and a shareable message/link.

### 2. Validate Referral Code
- **POST /referrals/validate**
- Body: `{ code: 'REFCODE' }`
- Checks if a referral code is valid before signup.

### 3. Referral Stats
- **GET /referrals/stats**
- Returns how many people the user referred and total rewards earned.

### 4. Referral History
- **GET /referrals/history**
- Returns a list of all users referred and their reward status.

### 5. User Profile (includes referral code)
- **GET /users/me**
- Returns user profile, including referral code and referral stats.

## Reward Flow
1. User shares their referral code.
2. Friend signs up with the code.
3. Referral document is created (status: pending).
4. Friend completes their first trip.
5. System sets `hasCompletedFirstTrip` to true, triggers reward.
6. Both users receive wallet credits (₦500 for referrer, ₦300 for referee).
7. Referral document status updates to rewarded.

## Notes for Frontend
- Show referral code in user profile/dashboard.
- Use `/referrals/my-code` for share links/messages.
- Validate referral code before signup with `/referrals/validate`.
- Show referral stats and history for user engagement.
- Rewards are credited automatically after the referred user's first trip.

## Example Response: GET /users/me
```
{
  "success": true,
  "user": {
    "_id": "...",
    "name": "Ahmed",
    "referral": {
      "code": "AHM9XK3P",
      "shareLink": "https://yourapp.com/signup?ref=AHM9XK3P",
      "totalReferrals": 3,
      "rewardedReferrals": 2,
      "totalEarnedNaira": "1000.00"
    }
    // ...other fields
  }
}
```

## Edge Cases
- Referral rewards only trigger once per referee (first trip).
- Self-referral is blocked.
- Expired or invalid codes are handled gracefully.

## Contact Backend Team
For questions or integration help, contact the backend team.
