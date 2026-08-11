/**
 * ZEROVA EV + BESS ROI 核心試算引擎 (三區塊版 + 多電價 + 淨毛利直算模組)
 */
const ROIEngine = {
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
    RATES: {
        // avgPowerCost 已移除，改由 UI 直接傳入每度電純利
        emsCost: 300000,         // EMS 系統費用 (元)
        auxPowerKw: 20           // 輔電系統預留容量 (kW)
    },

    /**
     * 第一區塊：單純充電站 (Baseline)
     */
    calcStandalone(inputs) {
        // chargingProfitPerKwh 為 UI 傳入的每度電淨毛利
        const { tariffType, gunCount, gunPower, dailyKwh, chargingProfitPerKwh, evCapexRate } = inputs;
        
        const totalPowerKw = gunCount * gunPower;
        const auxPowerKw = this.RATES.auxPowerKw;
        const recContractKw = totalPowerKw + auxPowerKw;
        
        // 動態計算總 CAPEX
        const evCapex = totalPowerKw * evCapexRate;

        const tariff = this.TARIFFS[tariffType] || this.TARIFFS['ev_dedicated'];

        // 賣電毛利 (直接使用：年總度數 * 每度電淨毛利)
        const annualKwh = dailyKwh * 365;
        const annualChargingProfit = annualKwh * chargingProfitPerKwh;

        // 基本電費支出
        const annualCapacityCost = recContractKw * (4 * tariff.basicSummer + 8 * tariff.basicNonSummer);
        const annualNetBenefit = annualChargingProfit - annualCapacityCost;
        
        const paybackYears = annualNetBenefit > 0 
            ? (evCapex / annualNetBenefit).toFixed(1) + " 年" 
            : "每年虧損 " + Math.round(Math.abs(annualNetBenefit) / 10000) + " 萬";

        return {
            tariff,
            totalPowerKw,
            auxPowerKw,
            recContractKw,
            evCapex,
            annualChargingProfit,
            annualCapacityCost,
            annualNetBenefit,
            paybackYears
        };
    },

    /**
     * 第二與第三區塊：充儲一體化 (BESS + DLM + TOU)
     */
    calcIntegrated(inputs, standaloneResult) {
        const {
            enableBess, targetContractKw, bessKw, bessKwh, bessTotalCost, chkAvoidCapex,
            enableDLM, enableTOU
        } = inputs;

        if (!enableBess) {
            const cashFlowA = [-standaloneResult.evCapex];
            for (let i = 1; i <= 10; i++) cashFlowA.push(-standaloneResult.evCapex + (standaloneResult.annualNetBenefit * i));
            return {
                enableBess: false,
                totalCapex: standaloneResult.evCapex,
                annualNetBenefit: standaloneResult.annualNetBenefit,
                paybackYears: standaloneResult.paybackYears,
                breakdown: { chargingProfit: standaloneResult.annualChargingProfit, capacitySavings: 0, touArbitrage: 0, penaltyAvoided: 0 },
                cashFlowA,
                cashFlowB: cashFlowA,
                suggestedContractKw: standaloneResult.recContractKw
            };
        }

        const sr = standaloneResult;
        const tariff = sr.tariff;

        const effectiveEvPower = enableDLM ? (sr.totalPowerKw * 0.6) : sr.totalPowerKw;
        const suggestedContractKw = Math.max(50, Math.round(effectiveEvPower - bessKw + sr.auxPowerKw));

        const avoidedCapexVal = chkAvoidCapex ? 1500000 : 0;
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
            enableBess: true,
            totalCapex,
            annualNetBenefit,
            paybackYears,
            suggestedContractKw,
            breakdown: {
                chargingProfit: sr.annualChargingProfit,
                capacitySavings: valCapacitySavings,
                touArbitrage: valTouArbitrage,
                penaltyAvoided: valPenaltyAvoided
            },
            cashFlowA,
            cashFlowB
        };
    },

    run(inputs) {
        const standalone = this.calcStandalone(inputs);
        const integrated = this.calcIntegrated(inputs, standalone);
        return { standalone, integrated };
    }
};
