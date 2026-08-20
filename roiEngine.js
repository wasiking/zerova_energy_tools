/**
 * ZEROVA EV + BESS ROI 核心試算引擎
 * (版本：v1200 | 包含 10年 SOH 線性衰退模型與匯出驗證模組)
 */
const ROIEngine = {
    // === 授權驗證模組 ===
    verifyExportAuth(user, pass) {
        // 預設的匯出權限帳號與密碼 (可在此修改)
        const validUser = "admin";
        const validPass = "zerova";
        return (user === validUser && pass === validPass);
    },

    // 1. 台電三種電價費率資料庫
    TARIFFS: {
        ev_dedicated: { 
            name: '電動車充換電設施專用電價', 
            basicSummer: 47.20 * 0.95, 
            basicNonSummer: 34.60 * 0.95,
            touDiffSummer: 7.05,
            touDiffNonSummer: 6.92
        },
        hv_3stage: { 
            name: '高壓工商業三段式時間電價', 
            basicSummer: 223.60, 
            basicNonSummer: 166.90, 
            touDiffSummer: 5.20,
            touDiffNonSummer: 3.50
        },
        ehv_3stage: { 
            name: '特高壓工商業三段式時間電價', 
            basicSummer: 216.40, 
            basicNonSummer: 161.40, 
            touDiffSummer: 4.80,
            touDiffNonSummer: 3.30
        }
    },

    // 2. 系統硬體與工程固定常數
    RATES: {
        emsCost: 300000,         // EMS 系統費用 (元)
        auxPowerKw: 20           // 輔電系統預留容量 (kW)
    },

    // 3. 內建電池物理規格 (不從前端接收，由邏輯層直接控制)
    BATTERY_SPECS: {
        dod: 0.90,               // 放電深度 (DOD) 90%
        rte: 0.85,               // 充放電轉換效率 (RTE) 85%
        sohEnd10Yr: 0.80         // 第 10 年末健康度 (SOH) 80%
    },

    /**
     * 第一區塊：單純充電站 (Baseline)
     */
    calcStandalone(inputs) {
        const { tariffType, gunCount, gunPower, dailyKwh, chargingServiceFee, evCapexRate } = inputs;
        
        const totalPowerKw = gunCount * gunPower;
        const recContractKw = totalPowerKw + this.RATES.auxPowerKw;
        const evCapex = totalPowerKw * evCapexRate;
        const tariff = this.TARIFFS[tariffType] || this.TARIFFS['ev_dedicated'];

        const annualChargingProfit = dailyKwh * 365 * chargingServiceFee;
        const annualCapacityCost = recContractKw * (4 * tariff.basicSummer + 8 * tariff.basicNonSummer);
        const annualNetBenefit = annualChargingProfit - annualCapacityCost;
        
        const tenYearNetProfit = (annualNetBenefit * 10) - evCapex;

        const paybackYears = annualNetBenefit > 0 
            ? (evCapex / annualNetBenefit).toFixed(1) + " 年" 
            : "每年虧損 " + Math.round(Math.abs(annualNetBenefit) / 10000) + " 萬";

        return {
            tariff, totalPowerKw, recContractKw, evCapex,
            annualChargingProfit, annualCapacityCost, annualNetBenefit,
            tenYearNetProfit, paybackYears
        };
    },

    /**
     * 第二與第三區塊：充儲一體化 (BESS + DLM + TOU)
     */
    calcIntegrated(inputs, standaloneResult) {
        const {
            enableBess, targetContractKw, bessKw, bessKwh, bessTotalCost, 
            chkAvoidCapex, avoidedCapexValue, enableDLM, enableTOU
        } = inputs;

        const sr = standaloneResult;

        // 若未開啟儲能，直接返回單充結果與 10 年現金流
        if (!enableBess) {
            const cashFlowA = [-sr.evCapex];
            for (let i = 1; i <= 10; i++) cashFlowA.push(-sr.evCapex + (sr.annualNetBenefit * i));
            return {
                enableBess: false, totalCapex: sr.evCapex, annualNetBenefit: sr.annualNetBenefit,
                tenYearNetProfit: sr.tenYearNetProfit, paybackYears: sr.paybackYears,
                breakdown: { chargingProfit: sr.annualChargingProfit, capacitySavings: 0, touArbitrage: 0, penaltyAvoided: 0 },
                cashFlowA, cashFlowB: cashFlowA, suggestedContractKw: sr.recContractKw
            };
        }

        const tariff = sr.tariff;
        const effectiveEvPower = enableDLM ? (sr.totalPowerKw * 0.6) : sr.totalPowerKw;
        const suggestedContractKw = Math.max(50, Math.round(effectiveEvPower - bessKw + this.RATES.auxPowerKw));

        const avoidedCapexVal = chkAvoidCapex ? avoidedCapexValue : 0;
        const totalCapex = Math.max(0, (sr.evCapex + bessTotalCost + this.RATES.emsCost) - avoidedCapexVal);

        // 1. 降約基本費節省
        const capacitySavedKw = Math.max(0, sr.recContractKw - targetContractKw);
        const valCapacitySavings = capacitySavedKw * (4 * tariff.basicSummer + 8 * tariff.basicNonSummer);

        // 2. 規避超約罰款
        let valPenaltyAvoided = 0;
        if (enableDLM) {
            valPenaltyAvoided = (sr.totalPowerKw * 0.15) * (tariff.basicSummer * 2 * 4 + tariff.basicNonSummer * 2 * 8);
        }

        // 3. 時間電價基準套利 (套用內建的 DOD 與 RTE)
        let baseTouArbitrage = 0;
        if (enableTOU) {
            const dailyBessDischargeBase = bessKwh * this.BATTERY_SPECS.dod * this.BATTERY_SPECS.rte; 
            baseTouArbitrage = dailyBessDischargeBase * (tariff.touDiffSummer * 122 + tariff.touDiffNonSummer * 243);
        }

        // 4. 計算 10 年期逐年衰退現金流
        const cashFlowA = [-sr.evCapex];
        const cashFlowB = [-totalCapex];
        let cumulativeA = -sr.evCapex;
        let cumulativeB = -totalCapex;
        
        let totalTou10Yr = 0;
        let totalBenefitB10Yr = 0;

        for (let i = 1; i <= 10; i++) {
            // SOH 每年線性衰退計算
            const currentSOH = 1 - (i - 1) * ((1 - this.BATTERY_SPECS.sohEnd10Yr) / 9);
            const currentTouArbitrage = baseTouArbitrage * currentSOH;
            totalTou10Yr += currentTouArbitrage;

            const yearlyBenefitB = sr.annualChargingProfit + valCapacitySavings + currentTouArbitrage + valPenaltyAvoided;
            totalBenefitB10Yr += yearlyBenefitB;

            cumulativeA += sr.annualNetBenefit;
            cumulativeB += yearlyBenefitB;

            cashFlowA.push(cumulativeA);
            cashFlowB.push(cumulativeB);
        }

        // 10 年平均值 (供 UI 渲染)
        const avgTouArbitrage = totalTou10Yr / 10;
        const avgAnnualNetBenefit = totalBenefitB10Yr / 10;
        const tenYearNetProfit = cumulativeB;

        const paybackYears = avgAnnualNetBenefit > 0 
            ? (totalCapex / avgAnnualNetBenefit).toFixed(1) + " 年" 
            : "每年虧損 " + Math.round(Math.abs(avgAnnualNetBenefit) / 10000) + " 萬";

        return {
            enableBess: true, totalCapex, annualNetBenefit: avgAnnualNetBenefit,
            tenYearNetProfit, paybackYears, suggestedContractKw,
            breakdown: {
                chargingProfit: sr.annualChargingProfit,
                capacitySavings: valCapacitySavings,
                touArbitrage: avgTouArbitrage,
                penaltyAvoided: valPenaltyAvoided
            },
            cashFlowA, cashFlowB
        };
    },

    run(inputs) {
        const standalone = this.calcStandalone(inputs);
        const integrated = this.calcIntegrated(inputs, standalone);
        return { standalone, integrated };
    }
};
