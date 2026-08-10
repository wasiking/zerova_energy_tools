/**
 * ZEROVA EV + BESS ROI 核心試算引擎 (三區塊版)
 */
const ROIEngine = {
    // 1. 台電費率與基礎常數 (以電動車專用電價為主)
    TARIFFS: {
        hv_ev: { name: '高壓專用電價', discount: 0.95 },
        lv_ev: { name: '低壓專用電價', discount: 1.00 }
    },
    RATES: {
        basicSummer: 47.20,      // 夏月經常契約基本費 (元/kW/月)
        basicNonSummer: 34.60,   // 非夏月經常契約基本費 (元/kW/月)
        
        // 時間電價 (未折扣前原價)
        peakSummer: 9.34,        // 夏月尖峰
        offPeakSummer: 2.29,     // 夏月離峰
        peakNonSummer: 9.10,     // 非夏月尖峰
        offPeakNonSummer: 2.18,  // 非夏月離峰

        avgPowerCost: 3.8,       // 預設台電平均購電成本 (元/kWh)
        evCapexRate: 6000,       // 充電樁完工建置單價 (元/kW)
        emsCost: 300000,         // EMS 系統費用 (元)
        auxPowerKw: 20           // 輔電系統預留容量 (kW)
    },

    /**
     * 第一區塊：單純充電站 (Baseline)
     */
    calcStandalone(inputs) {
        const { tariffType, gunCount, gunPower, dailyKwh, chargingPrice } = inputs;
        
        const totalPowerKw = gunCount * gunPower;
        const auxPowerKw = this.RATES.auxPowerKw;
        
        // 建議契約容量 (無儲能：全功率輸出 + 輔電)
        const recContractKw = totalPowerKw + auxPowerKw;
        const evCapex = totalPowerKw * this.RATES.evCapexRate;

        // 折算費率 (高壓 95%)
        const discount = this.TARIFFS[tariffType]?.discount || 0.95;
        const basicSummer = this.RATES.basicSummer * discount;
        const basicNonSummer = this.RATES.basicNonSummer * discount;

        // 賣電毛利
        const annualKwh = dailyKwh * 365;
        const annualChargingProfit = annualKwh * (chargingPrice - this.RATES.avgPowerCost);

        // 基本電費支出
        const annualCapacityCost = recContractKw * (4 * basicSummer + 8 * basicNonSummer);
        const annualNetBenefit = annualChargingProfit - annualCapacityCost;
        const paybackYears = annualNetBenefit > 0 ? (evCapex / annualNetBenefit).toFixed(1) : "無法回本";

        return {
            totalPowerKw,
            auxPowerKw,
            recContractKw,
            evCapex,
            annualChargingProfit,
            annualCapacityCost,
            annualNetBenefit,
            paybackYears,
            discount,
            basicSummer,
            basicNonSummer
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

        // 計算最佳建議契約容量 (供 UI 提示)
        // 若啟用 DLM：充電樁負載限縮為 60%
        const effectiveEvPower = enableDLM ? (sr.totalPowerKw * 0.6) : sr.totalPowerKw;
        // 建議值 = (有效充電負載 - 儲能放電功率 + 輔電)
        const suggestedContractKw = Math.max(50, Math.round(effectiveEvPower - bessKw + sr.auxPowerKw));

        // CAPEX 計算 (充電樁 + 儲能總價 + EMS - 擴容避險)
        const avoidedCapexVal = chkAvoidCapex ? 1500000 : 0;
        const totalCapex = Math.max(0, (sr.evCapex + bessTotalCost + this.RATES.emsCost) - avoidedCapexVal);

        // 效益 1：降低基本電費節省
        const capacitySavedKw = Math.max(0, sr.recContractKw - targetContractKw);
        const valCapacitySavings = capacitySavedKw * (4 * sr.basicSummer + 8 * sr.basicNonSummer);

        // 效益 2：時間電價套利 (若開啟 TOU)
        let valTouArbitrage = 0;
        if (enableTOU) {
            const dailyBessDischarge = bessKwh * 0.9 * 0.88; // DoD 90%, RTE 88%
            const summerDiff = (this.RATES.peakSummer - this.RATES.offPeakSummer) * sr.discount;
            const nonSummerDiff = (this.RATES.peakNonSummer - this.RATES.offPeakNonSummer) * sr.discount;
            valTouArbitrage = (dailyBessDischarge * summerDiff * 122) + (dailyBessDischarge * nonSummerDiff * 243);
        }

        // 效益 3：防超約罰款規避價值 (若開啟 DLM，預設擋下 15% 的突發超約)
        let valPenaltyAvoided = 0;
        if (enableDLM) {
            valPenaltyAvoided = (sr.totalPowerKw * 0.15) * (sr.basicSummer * 2 * 4 + sr.basicNonSummer * 2 * 8);
        }

        // 總綜合效益與回收期
        const annualNetBenefit = sr.annualChargingProfit + valCapacitySavings + valTouArbitrage + valPenaltyAvoided;
        const paybackYears = annualNetBenefit > 0 ? (totalCapex / annualNetBenefit).toFixed(1) : "無法回本";

        // 現金流陣列
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
