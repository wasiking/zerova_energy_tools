/**
 * ZEROVA EV + BESS ROI 核心試算引擎 (支援 10 年淨利計算與動態擴容費)
 */
const ROIEngine = {
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
    RATES: {
        emsCost: 300000,         
        auxPowerKw: 20           
    },

    calcStandalone(inputs) {
        // chargingServiceFee 代表輸入的每度電純利
        const { tariffType, gunCount, gunPower, dailyKwh, chargingServiceFee, evCapexRate } = inputs;
        
        const totalPowerKw = gunCount * gunPower;
        const recContractKw = totalPowerKw + this.RATES.auxPowerKw;
        const evCapex = totalPowerKw * evCapexRate;
        const tariff = this.TARIFFS[tariffType] || this.TARIFFS['ev_dedicated'];

        const annualKwh = dailyKwh * 365;
        const annualChargingProfit = annualKwh * chargingServiceFee;

        const annualCapacityCost = recContractKw * (4 * tariff.basicSummer + 8 * tariff.basicNonSummer);
        const annualNetBenefit = annualChargingProfit - annualCapacityCost;
        
        // 計算十年整體淨收益：(每年淨利 * 10) - 建置成本
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

    calcIntegrated(inputs, standaloneResult) {
        const {
            enableBess, targetContractKw, bessKw, bessKwh, bessTotalCost, 
            chkAvoidCapex, avoidedCapexValue, enableDLM, enableTOU
        } = inputs;

        const sr = standaloneResult;

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

        // 依據輸入框的數值動態扣除擴容費
        const avoidedCapexVal = chkAvoidCapex ? avoidedCapexValue : 0;
        const totalCapex = Math.max(0, (sr.evCapex + bessTotalCost + this.RATES.emsCost) - avoidedCapexVal);

        const capacitySavedKw = Math.max(0, sr.recContractKw - targetContractKw);
        const valCapacitySavings = capacitySavedKw * (4 * tariff.basicSummer + 8 * tariff.basicNonSummer);

        let valTouArbitrage = 0;
        if (enableTOU) {
            const dailyBessDischarge = bessKwh * 0.9 * 0.88; 
            valTouArbitrage = (dailyBessDischarge * tariff.touDiffSummer * 122) + (dailyBessDischarge * tariff.touDiffNonSummer * 243);
        }

        let valPenaltyAvoided = 0;
        if (enableDLM) {
            valPenaltyAvoided = (sr.totalPowerKw * 0.15) * (tariff.basicSummer * 2 * 4 + tariff.basicNonSummer * 2 * 8);
        }

        const annualNetBenefit = sr.annualChargingProfit + valCapacitySavings + valTouArbitrage + valPenaltyAvoided;
        
        // 充儲一體的十年整體淨收益
        const tenYearNetProfit = (annualNetBenefit * 10) - totalCapex;

        const paybackYears = annualNetBenefit > 0 
            ? (totalCapex / annualNetBenefit).toFixed(1) + " 年" 
            : "每年虧損 " + Math.round(Math.abs(annualNetBenefit) / 10000) + " 萬";

        const cashFlowA = [-sr.evCapex];
        const cashFlowB = [-totalCapex];
        for (let i = 1; i <= 10; i++) {
            cashFlowA.push(-sr.evCapex + (sr.annualNetBenefit * i));
            cashFlowB.push(-totalCapex + (annualNetBenefit * i));
        }

        return {
            enableBess: true, totalCapex, annualNetBenefit, 
            tenYearNetProfit, paybackYears, suggestedContractKw,
            breakdown: {
                chargingProfit: sr.annualChargingProfit,
                capacitySavings: valCapacitySavings,
                touArbitrage: valTouArbitrage,
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
